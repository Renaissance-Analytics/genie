import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import * as protocol from '../src/core/remote-protocol.js';
import type { PreAuth, ServerConnection, WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

// Each send drains the real host's async frame handler; an unanswered frame is an assertion failure, never a timeout.
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const owner: PreAuth = { label: 'relay owner', isOwner: true, workspaceId: null, readonly: false };
const localProof = { kind: 'local' as const, label: 'this window', isOwner: true, workspaceId: null, readonly: false };
let dir: string;
let devices: DeviceStore;
let host: RemoteHost;
let baton: Baton;
let admit: (connection: ServerConnection) => void;
let invoke: ReturnType<typeof vi.fn<HostApi['invoke']>>;
let listening = 0;
const clients: Array<ReturnType<typeof peer>> = [];

function peer(preAuth?: PreAuth, profile?: 'mobile') {
    const pair = protocol.inMemoryPair();
    admit({ ...pair.server, ...(preAuth ? { preAuth } : {}) });
    const frames: WireMessage[] = [];
    pair.client.onMessage((text) => { frames.push(JSON.parse(text) as WireMessage); });
    let id = 0;
    const send = async (frame: unknown) => {
        frames.length = 0;
        pair.client.send(JSON.stringify(frame));
        await settled();
        return frames.at(-1);
    };
    return {
        hello: (auth: unknown) => send({ kind: 'hello', auth, ...(profile ? { profile } : {}) }),
        call: (method: string, ...args: unknown[]) => send({ kind: 'call', id: ++id, method, args }),
        close: () => pair.client.close(),
    };
}

function connect(preAuth?: PreAuth, profile?: 'mobile') {
    const p = peer(preAuth, profile);
    clients.push(p);
    return p;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-local-auth-'));
    let tokenSeq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `fixture-token-${++tokenSeq}` });
    baton = new Baton();
    invoke = vi.fn(async (_method, args) => ({ args }));
    listening = 0;
    host = new RemoteHost({
        api: { invoke, onEvent: () => { listening++; return () => { listening--; }; }, workspaceOfAgent: () => 'work' },
        hostName: 'local-contract-host', baton, pins: new PairingPins({ now: Date.now }), devices,
        confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { admit = listener; return () => {}; } },
    });
});

afterEach(async () => {
    for (const p of clients.splice(0)) p.close();
    await settled();
    vi.restoreAllMocks();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('P4 local authentication', () => {
    it('parses a tokenless local hello', () => {
        expect(protocol.parseMessage('{"kind":"hello","auth":{"kind":"local"}}')).toEqual({
            ok: true, message: { kind: 'hello', auth: { kind: 'local' } },
        });
    });

    it('a door-proved connection is owner of the whole host and receives no token', async () => {
        expect(await connect(localProof).hello({ kind: 'local' })).toEqual({
            kind: 'welcome', connectionId: expect.any(String), host: 'local-contract-host', isOwner: true, workspaceId: null,
            // P10.1e's version handshake, additive; a host given no build says 'dev'.
            protocol: protocol.REMOTE_PROTOCOL, build: 'dev',
        });
        expect(devices.list()).toEqual([]);
    });

    it.each([
        ['tailnet', undefined],
        ['relay owner', owner],
        ['relay guest', { ...owner, isOwner: false, workspaceId: 'work' }],
    ] as const)('%s does not admit local authentication', async (_kind, proof) => {
        expect(await connect(proof).hello({ kind: 'local' })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/local|own window/i) });
        expect(host.connections()).toEqual([]);
        expect(invoke).not.toHaveBeenCalled();
        expect(devices.list()).toEqual([]);
    });

    it.each(['pin', 'token', 'relay'])('the local door accepts only local authentication, not %s', async (kind) => {
        const { code } = host.issuePin();
        const token = devices.pair('paired owner').token;
        expect(await connect(localProof).hello({ kind, code, token })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/local|own window/i) });
        expect(host.connections()).toEqual([]);
    });

    it('a second hello on a live connection has a visible refusal', async () => {
        const p = connect();
        const token = devices.pair('paired owner').token;
        expect(await p.hello({ kind: 'token', token })).toMatchObject({ kind: 'welcome' });
        expect(await p.hello({ kind: 'token', token })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/already|hello/i) });
        expect(host.connections()).toHaveLength(1);
    });
});

describe('P4 local capability policy, with a test-only capability assignment', () => {
    // PR2 adds no methods. The coordinator's spec calls for this spy; production capabilities remain unchanged.
    const kinds = ['tailnet owner', 'relay owner', 'workspace guest', 'host guest', 'readonly relay', 'phone owner', 'phone relay guest'] as const;
    it.each(kinds)('%s receives a reason and never calls a local-capability API', async (kind) => {
        const relay = kind.includes('relay') || kind.includes('guest');
        const guest = kind.includes('guest');
        const proof = relay ? { ...owner, isOwner: !guest, workspaceId: kind === 'workspace guest' ? 'work' : null, readonly: kind === 'readonly relay' } : undefined;
        const p = connect(proof, kind.startsWith('phone') ? 'mobile' : undefined);
        const token = devices.pair('paired owner').token;
        expect(await p.hello(relay ? { kind: 'relay' } : { kind: 'token', token })).toMatchObject({ kind: 'welcome' });
        vi.spyOn(protocol, 'capabilityOf').mockReturnValue('local');
        expect(await p.call('workspaces.settings', 'work')).toMatchObject({ kind: 'result', ok: false, reason: expect.any(String) });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('a locally authenticated call ignores a remote driver and the host lock; null arguments stay null', async () => {
        const remote = connect();
        const token = devices.pair('remote driver').token;
        await remote.hello({ kind: 'token', token });
        await remote.call('baton.take');
        const driver = baton.holder();
        const local = connect(localProof);
        expect(await local.hello({ kind: 'local' })).toMatchObject({ kind: 'welcome' });
        expect(await local.call('workspaces.setSetting', 'work', 'theme', null)).toMatchObject({ kind: 'result', ok: true, value: { args: ['work', 'theme', null] } });
        host.lock();
        expect(await local.call('workspaces.setSetting', 'work', 'theme', null)).toMatchObject({ kind: 'result', ok: true });
        expect(baton.holder()).toEqual(driver);
        expect(await remote.call('workspaces.setSetting', 'work', 'theme', null)).toMatchObject({ kind: 'result', ok: false, reason: 'this Genie is locked' });
    });

    it('CONTROL: remote writes still need their own baton and reads do not', async () => {
        const p = connect();
        await p.hello({ kind: 'token', token: devices.pair('remote one').token });
        expect(await p.call('workspaces.setSetting', 'work', 'theme', null)).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('take the baton') });
        await p.call('baton.take');
        const other = connect();
        await other.hello({ kind: 'token', token: devices.pair('remote two').token });
        expect(await other.call('workspaces.setSetting', 'work', 'theme', null)).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('driving') });
        expect(await other.call('workspaces.settings', 'work')).toMatchObject({ kind: 'result', ok: true });
        expect(await p.call('workspaces.setSetting', 'work', 'theme', null)).toMatchObject({ kind: 'result', ok: true });
    });
});

it('a pending agent watch finishing after close does not restart the API subscription', async () => {
    const p = connect();
    await p.hello({ kind: 'token', token: devices.pair('watch owner').token });
    expect(listening).toBe(1);
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = p.call('agent.watch', 'agent_a', {});
    await settled();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('agentDetail', ['agent_a'], expect.anything());
    p.close();
    await settled();
    expect(listening).toBe(0);
    expect(host.connections()).toEqual([]);
    finish({ rows: [], agentId: 'agent_a' });
    await pending;
    await settled();
    expect(listening).toBe(0);
    expect(host.connections()).toEqual([]);
});

it.each([false, true])('a completed watch consumes its ledger only while its connection is live (closed: %s)', async (closed) => {
    const p = connect();
    await p.hello({ kind: 'token', token: devices.pair('watch state owner').token });
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = p.call('agent.watch', 'agent_a', {});
    await settled();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('agentDetail', ['agent_a'], expect.anything());
    if (closed) { p.close(); await settled(); }
    let ledgerReads = 0;
    finish({ agentId: 'agent_a', get rows() { ledgerReads++; return []; } });
    await pending;
    await settled();
    // Building and recording a window consumes the rows. The live row proves the same getter observes that work.
    expect(ledgerReads).toBe(closed ? 0 : 1);
    expect(host.connections()).toHaveLength(closed ? 0 : 1);
});
