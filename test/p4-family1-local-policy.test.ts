import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type PreAuth, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { buildHostApi } from '../src/main/host-api.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { AGENT_PUSH_INTERVAL_MS } from '../src/main/agent-push.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const localProof: PreAuth = { kind: 'local', label: 'local window', isOwner: true, workspaceId: null, readonly: false };
const relayOwner: PreAuth = { label: 'relay owner', isOwner: true, workspaceId: null, readonly: false };
let dir: string;
let devices: DeviceStore;
let baton: Baton;
let host: RemoteHost;
let accept: (connection: ServerConnection) => void;
let emit: (channel: string, payload: unknown) => void;
let invoke: ReturnType<typeof vi.fn<HostApi['invoke']>>;
const closes: Array<() => void> = [];

function install(api: HostApi) {
    host = new RemoteHost({ api, hostName: 'family-host', baton, devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } },
    });
}

function peer(proof?: PreAuth, mobile = false) {
    const pair = inMemoryPair();
    accept({ ...pair.server, ...(proof ? { preAuth: proof } : {}) });
    const frames: WireMessage[] = [];
    pair.client.onMessage((text) => { frames.push(JSON.parse(text) as WireMessage); });
    let id = 0;
    const send = async (frame: unknown) => {
        frames.length = 0;
        pair.client.send(JSON.stringify(frame));
        await tick();
        return frames.at(-1);
    };
    const p = {
        hello: (auth: unknown) => send({ kind: 'hello', auth, ...(mobile ? { profile: 'mobile' } : {}) }),
        call: (method: string, ...args: unknown[]) => send({ kind: 'call', id: ++id, method, args }),
        events: () => frames.filter((frame) => frame.kind === 'event'),
        clear: () => { frames.length = 0; },
        close: () => pair.client.close(),
    };
    closes.push(p.close);
    return p;
}

async function local() {
    const p = peer(localProof);
    expect(await p.hello({ kind: 'local' })).toMatchObject({ kind: 'welcome' });
    p.clear();
    return p;
}
async function remote() {
    const p = peer();
    expect(await p.hello({ kind: 'token', token: devices.pair('remote driver').token })).toMatchObject({ kind: 'welcome' });
    p.clear();
    return p;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-family1-policy-'));
    let nextToken = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family-fixture-${++nextToken}` });
    baton = new Baton();
    invoke = vi.fn(async (_method, args) => ({ args }));
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    emit = (channel, payload) => { for (const listener of listeners) listener(channel, payload); };
    install({ invoke, onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, workspaceOfAgent: () => 'work' });
});
afterEach(async () => {
    for (const close of closes.splice(0)) close();
    await tick();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('local windows are not remote devices or remote state changes', () => {
    it('keeps the local window out of the roster while a remote connection is the positive control', async () => {
        await local();
        expect(host.connections()).toEqual([]);
        await remote();
        expect(host.connections()).toEqual([{ id: expect.any(String), label: 'remote driver', isOwner: true, workspaceId: null, driving: false }]);
    });
    it('local hello/close request no remote-state snapshot; remote hello/close still notify', async () => {
        const change = vi.fn();
        host.onChange(change);
        const here = await local();
        expect(change).not.toHaveBeenCalled();
        here.close(); await tick();
        expect(change).not.toHaveBeenCalled();
        const there = await remote();
        expect(change).toHaveBeenCalledTimes(1);
        there.close(); await tick();
        expect(change).toHaveBeenCalledTimes(2);
    });
    it.each(['baton.take', 'host.lock', 'host.unlock'])('refuses local %s without changing remote controls', async (method) => {
        const here = await local();
        if (method === 'host.unlock') host.lock();
        const locked = host.locked();
        expect(await here.call(method)).toMatchObject({ kind: 'result', ok: false, reason: expect.any(String) });
        expect(host.locked()).toBe(locked);
        expect(baton.holder()).toBeNull();
        const there = await remote();
        expect(await there.call(method)).toMatchObject({ kind: 'result', ok: true });
        if (method === 'baton.take') expect(baton.holder()).not.toBeNull();
        else expect(host.locked()).toBe(method === 'host.lock');
    });
    it('keeps local writes working while a remote holds the baton and lock', async () => {
        const there = await remote();
        await there.call('baton.take');
        await there.call('host.lock');
        const holder = baton.holder();
        const here = await local();
        expect(await here.call('workspaces.setSetting', 'work', 'workspace_tabs', '{}')).toMatchObject({ kind: 'result', ok: true });
        expect(invoke).toHaveBeenCalledExactlyOnceWith('workspaces.setSetting', ['work', 'workspace_tabs', '{}'], expect.anything());
        expect(baton.holder()).toEqual(holder);
        expect(host.locked()).toBe(true);
    });
});

describe('family 1 events', () => {
    const otherEvents = ['snapshot', 'agent:agent_a', 'terminal-data', 'terminal-exit', 'features', 'updates', 'activity', 'unclassified-event'];
    it.each(otherEvents)('local connections receive no unmoved %s event, with a remote control', async (channel) => {
        const here = await local();
        const there = await remote();
        here.clear(); there.clear();
        const payload = { marker: channel };
        emit(channel, payload);
        await tick();
        expect(there.events()).toContainEqual({ kind: 'event', channel, payload });
        expect(here.events()).toEqual([]);
    });
    const kinds = ['tailnet owner', 'relay owner', 'readonly relay', 'workspace guest', 'host guest', 'phone owner', 'phone relay guest'] as const;
    it.each(kinds)('%s does not hear the local settings event, while a local window does', async (kind) => {
        const here = await local();
        const relay = kind.includes('relay') || kind.includes('guest');
        const guest = kind.includes('guest');
        const proof = relay ? { ...relayOwner, isOwner: !guest, workspaceId: kind === 'workspace guest' ? 'work' : null, readonly: kind === 'readonly relay' } : undefined;
        const there = peer(proof, kind.startsWith('phone'));
        expect(await there.hello(relay ? { kind: 'relay' } : { kind: 'token', token: devices.pair(kind).token })).toMatchObject({ kind: 'welcome' });
        here.clear(); there.clear();
        emit('workspace-settings-changed', 'work');
        await tick();
        expect(here.events()).toEqual([{ kind: 'event', channel: 'workspace-settings-changed', payload: 'work' }]);
        expect(there.events()).toEqual([]);
    });
});

describe('the real HostApi does no detail construction for local streaming', () => {
    function source() {
        const deps = protocolContractDeps(dir);
        const detail = vi.fn(() => ({ agentId: 'agent_a', rows: [] }) as never);
        const snapshot = vi.fn(deps.snapshot);
        const features = vi.fn(deps.features.snapshot);
        const openTerminal = vi.fn(deps.terminals.open);
        const listTerminals = vi.fn(deps.terminals.list);
        const schedule = vi.fn((_ms: number, _fn: () => void) => () => {});
        const streaming = new Set<(id: string) => void>();
        const registrations = { snapshot: 0, records: 0, host: 0, data: 0, exit: 0, features: 0 };
        const count = (key: keyof typeof registrations) => { registrations[key]++; return () => { registrations[key]--; }; };
        deps.snapshot = snapshot;
        deps.detailFor = detail;
        deps.features.snapshot = features;
        deps.terminals.open = openTerminal;
        deps.terminals.list = listTerminals;
        deps.subscribeSnapshot = () => count('snapshot');
        deps.subscribeAgentRecords = () => count('records');
        deps.host.subscribe = (listener) => { streaming.add(listener); const off = count('host'); return () => { streaming.delete(listener); off(); }; };
        deps.terminals.onData = () => count('data');
        deps.terminals.onExit = () => count('exit');
        deps.features.onChange = () => count('features');
        let now = 0;
        deps.now = () => now;
        deps.schedule = schedule;
        install(buildHostApi(deps));
        return { detail, snapshot, features, openTerminal, listTerminals, schedule, registrations,
            chunk: () => { now += AGENT_PUSH_INTERVAL_MS + 1; for (const listener of streaming) listener('agent_a'); },
        };
    }
    it('initial listening only registers callbacks: no snapshot, detail, feature build, terminal work or timer', async () => {
        const s = source();
        const here = await local();
        expect(s.registrations).toEqual({ snapshot: 1, records: 1, host: 1, data: 1, exit: 1, features: 1 });
        for (const fn of [s.detail, s.snapshot, s.features, s.openTerminal, s.listTerminals, s.schedule]) expect(fn).not.toHaveBeenCalled();
        expect(here.events()).toEqual([]);
        here.close(); await tick();
        expect(Object.values(s.registrations)).toEqual([0, 0, 0, 0, 0, 0]);
    });
    it.each(['local', 'remote'])('%s streaming has the required detail/frame count; the remote row proves the gauge', async (kind) => {
        const s = source();
        const p = kind === 'local' ? await local() : await remote();
        for (let i = 0; i < 100; i++) s.chunk();
        await tick();
        const expected = kind === 'local' ? 0 : 100;
        expect(s.detail).toHaveBeenCalledTimes(expected);
        expect(p.events().filter((frame) => frame.channel === 'agent:agent_a')).toHaveLength(expected);
    });
});
