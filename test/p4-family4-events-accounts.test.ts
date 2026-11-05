import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, type PreAuth, type RemoteMethod, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import type { ActivityFeed } from '../src/core/activity-feed.js';
import type { Headroom } from '../src/core/headroom.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const localProof: PreAuth = { kind: 'local', label: 'local', isOwner: true, workspaceId: null, readonly: false };
const room = { claude: { plan: null, window: '5h', leftPct: 40, resetsAtMs: 500, over: false, windows: [] } } satisfies Record<string, Headroom>;
const feed: ActivityFeed = { agentId: 'agent_a', running: true, since: 10, lastAt: 20, plan: null, beats: [{ minute: 0, n: 2 }], items: [] };
const state = { phase: 'idle', version: null, percent: null, error: null, checkedAt: null } as const;
const localEvents = ['local-updates', 'local-activity', 'local-headroom'] as const;
const newMethods = ['updates.notes', 'headroom', 'accountRetry'] as const;
const kinds = ['tailnet owner', 'relay owner', 'workspace guest', 'host guest', 'readonly relay', 'phone owner', 'phone relay guest'] as const;
let dir: string, devices: DeviceStore;
const closes: Array<() => void> = [];

function signals<T>() {
    const listeners = new Set<(value: T) => void>();
    return { subscribe: (listener: (value: T) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        emit: (value: T) => { for (const listener of listeners) listener(value); } };
}
function setup() {
    const updates = signals<typeof state>(), activity = signals<ActivityFeed>(), headroom = signals<Record<string, Headroom>>();
    const deps = protocolContractDeps(dir), retry = vi.fn((_provider: string) => {}), view = vi.fn(() => room);
    deps.updates = { state: () => state, check: async () => state, download: async () => false, install: () => null, onChange: updates.subscribe };
    Object.assign(deps.updates, { notes: vi.fn(async () => state) });
    deps.activity = { feeds: () => ({ agent_a: feed }), subscribe: activity.subscribe };
    Object.assign(deps, { headroom: { view, subscribe: headroom.subscribe }, retryPausedAccount: retry });
    return { deps, updates, activity, headroom, retry, view };
}
function server(deps: HostApiDeps) {
    const api = buildHostApi(deps), invoke = vi.spyOn(api, 'invoke');
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let accept!: (connection: ServerConnection) => void;
    const host = new RemoteHost({ api, hostName: 'family4-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = (connection) => {
            connection.onMessage((text) => { const frame = JSON.parse(text) as WireMessage; if (frame.kind === 'call') calls.push({ method: frame.method, args: frame.args }); });
            listener(connection);
        }; return () => {}; } } });
    function raw(proof?: PreAuth, mobile = false) {
        const pair = inMemoryPair(), frames: WireMessage[] = [];
        pair.client.onMessage((text) => { frames.push(JSON.parse(text) as WireMessage); });
        accept({ ...pair.server, ...(proof ? { preAuth: proof } : {}) }); closes.push(() => pair.client.close());
        let id = 0;
        const send = async (frame: unknown) => { frames.length = 0; pair.client.send(JSON.stringify(frame)); await tick(); return frames.at(-1); };
        return { hello: () => send({ kind: 'hello', auth: proof ? { kind: proof.kind === 'local' ? 'local' : 'relay' } : { kind: 'token', token: devices.pair('owner').token }, ...(mobile ? { profile: 'mobile' } : {}) }),
            call: (method: string, ...args: unknown[]) => send({ kind: 'call', id: ++id, method, args }),
            events: () => frames.filter((frame) => frame.kind === 'event'), clear: () => { frames.length = 0; }, close: () => pair.client.close() };
    }
    function port(): LocalFramePort {
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let active: ReturnType<typeof inMemoryPair> | undefined, handle = '';
        return { onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, send: (action, id, text) => {
            if (action === 'open') {
                active?.client.close(); active = inMemoryPair(); handle = id;
                active.client.onMessage((frame) => { for (const listener of listeners) listener('frame', handle, frame); });
                active.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
                closes.push(() => active?.client.close()); accept({ ...active.server, preAuth: localProof });
            } else if (action === 'frame') active?.client.send(text); else active?.client.close();
        } };
    }
    return { invoke, calls, raw, port, connect: async () => {
        const pair = inMemoryPair(); accept({ ...pair.server, preAuth: localProof });
        const client = connectRemote(pair.client, { kind: 'local' }, 'family4'); closes.push(() => client.close());
        expect(await client.ready).toEqual({ ok: true }); return client;
    } };
}
async function admitted(p: ReturnType<ReturnType<typeof server>['raw']>) { expect(await p.hello()).toMatchObject({ kind: 'welcome' }); p.clear(); return p; }
function other(source: ReturnType<typeof server>, kind: typeof kinds[number]) {
    const relay = kind.includes('relay') || kind.includes('guest'), guest = kind.includes('guest');
    return source.raw(relay ? { label: kind, isOwner: !guest, workspaceId: kind === 'workspace guest' ? 'work' : null, readonly: kind === 'readonly relay' } : undefined, kind.startsWith('phone'));
}
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-family4-events-')); let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family4-${++seq}` });
});
afterEach(async () => {
    for (const close of closes.splice(0)) close(); vi.unstubAllGlobals(); await tick(); await devices.flushed(); await rm(dir, { recursive: true, force: true });
});

describe('the three new family4 product methods are local', () => {
    it.each(newMethods)('%s is classified local', (method) => { expect(capabilityOf(method as RemoteMethod)).toBe('local'); });
    it.each(kinds)('%s cannot call any new product method or activity connection control', async (kind) => {
        const f = setup(), source = server(f.deps), peer = await admitted(other(source, kind));
        for (const method of [...newMethods, 'activity.watch', 'activity.unwatch']) {
            expect(await peer.call(method, 'agent_a')).toMatchObject({ kind: 'result', ok: false, reason: expect.any(String) });
        }
        expect(source.invoke).not.toHaveBeenCalled(); expect(f.retry).not.toHaveBeenCalled(); expect(f.view).not.toHaveBeenCalled();
    });
    it('accountRetry preserves native agent validation, translates to the provider and returns the native result', async () => {
        const f = setup(), find = vi.spyOn(f.deps, 'find'), source = server(f.deps), client = await source.connect();
        const oldInvoke = vi.fn(async (_channel: string, _agent: string) => ({ ok: true }));
        expect(await client.bridge.accountRetry!('agent_a')).toEqual(await oldInvoke('genie:account-retry', 'agent_a'));
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith('accountRetry', ['agent_a']); expect(find).toHaveBeenCalledExactlyOnceWith('agent_a');
        expect(f.retry).toHaveBeenCalledExactlyOnceWith('claude');
    });
    it.each([undefined, null, false, 42, {}, [], 'missing'])('accountRetry preserves the native refusal for %j before retrying a provider', async (raw) => {
        const f = setup(), source = server(f.deps), client = await source.connect();
        expect(await client.bridge.accountRetry!(raw as string)).toEqual({ ok: false, reason: 'No agent named.' }); expect(f.retry).not.toHaveBeenCalled();
    });
    it('accountRetry exposes a thrown provider-retry failure without inventing success', async () => {
        const f = setup(); f.retry.mockImplementation(() => { throw new Error('fixture retry unavailable'); });
        const source = server(f.deps), client = await source.connect();
        expect(await client.bridge.accountRetry!('agent_a')).toEqual({ ok: false, reason: 'fixture retry unavailable' });
    });
    it('pageBridge uses shared account retry while both login window ports retain native identity', async () => {
        const f = setup(), source = server(f.deps); vi.stubGlobal('window', { genieLocalProtocol: source.port() });
        const oldRetry = vi.fn(async () => ({ ok: false, reason: 'old native path' })), providerLogin = vi.fn(async () => ({ ok: true })), designLogin = vi.fn(async () => ({ ok: true }));
        const bridge = pageBridge({ accountRetry: oldRetry, providerLogin, designLogin, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge);
        expect(await bridge.accountRetry!('agent_a')).toEqual({ ok: true }); expect(oldRetry).not.toHaveBeenCalled(); expect(f.retry).toHaveBeenCalledExactlyOnceWith('claude');
        expect(bridge.providerLogin).toBe(providerLogin); expect(bridge.designLogin).toBe(designLogin);
        await bridge.providerLogin('agent_a'); await bridge.designLogin!('agent_a');
        expect(providerLogin).toHaveBeenCalledExactlyOnceWith('agent_a'); expect(designLogin).toHaveBeenCalledExactlyOnceWith('agent_a');
        expect(capabilityOf('providerLogin')).toBe('host-only');
    });
    it('retires headroom/accountRetry native paths and classifies both retained logins as window ports', () => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inventory = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        for (const channel of ['genie:headroom', 'genie:account-retry']) {
            expect(main).not.toContain(`ipcMain.handle('${channel}'`); expect(preload).not.toContain(`ipcRenderer.invoke('${channel}'`); expect(inventory).not.toContain(`['${channel}',`);
        }
        for (const channel of ['genie:provider-login', 'genie:design-login']) {
            expect(main).toContain(`ipcMain.handle('${channel}'`); expect(preload).toContain(`ipcRenderer.invoke('${channel}'`); expect(inventory).toContain(`['${channel}', 'window-port']`);
        }
    });
});

describe('family4 subscriptions on the shared page connection', () => {
    it.each(['client', 'page'] as const)('%s headroom preserves the native initial read, subsequent map and unsubscribe', async (target) => {
        const f = setup(), source = server(f.deps);
        vi.stubGlobal('window', { genieLocalProtocol: source.port() });
        const old = vi.fn();
        const bridge = target === 'client' ? (await source.connect()).bridge : pageBridge({ onHeadroom: old, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge);
        const received = vi.fn(), off = bridge.onHeadroom!(received); await tick();
        expect(received).toHaveBeenCalledExactlyOnceWith(room); expect(f.view).toHaveBeenCalledExactlyOnceWith();
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith('headroom', []); expect(old).not.toHaveBeenCalled();
        const next = { claude: { ...room.claude, leftPct: 39 } }; f.headroom.emit(next); await tick();
        expect(received).toHaveBeenLastCalledWith(next); off(); received.mockClear(); f.headroom.emit(room); await tick(); expect(received).not.toHaveBeenCalled();
    });
    it('headroom preserves a null initial read', async () => {
        const f = setup(); f.view.mockReturnValue(null as never); const client = await server(f.deps).connect(), received = vi.fn();
        const off = client.bridge.onHeadroom!(received); await tick(); expect(received).toHaveBeenCalledExactlyOnceWith(null); off();
    });
    it('unsubscribing headroom before its initial answer suppresses that callback', async () => {
        const f = setup(), client = await server(f.deps).connect(), received = vi.fn(); const off = client.bridge.onHeadroom!(received); off(); await tick(); expect(received).not.toHaveBeenCalled();
    });
    it('page updates and activity receive new local events, detach independently and never subscribe through preload', async () => {
        const f = setup(), source = server(f.deps); vi.stubGlobal('window', { genieLocalProtocol: source.port() });
        const nativeUpdates = vi.fn(), nativeActivity = vi.fn();
        const bridge = pageBridge({ updates: { subscribe: nativeUpdates }, activity: { subscribe: nativeActivity }, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge);
        const u = vi.fn(), a = vi.fn(), offU = bridge.updates.subscribe(u), offA = bridge.activity!.subscribe(a); await tick();
        f.updates.emit(state); f.activity.emit(feed); await tick(); expect(u).toHaveBeenCalledExactlyOnceWith(state); expect(a).toHaveBeenCalledExactlyOnceWith(feed);
        expect(nativeUpdates).not.toHaveBeenCalled(); expect(nativeActivity).not.toHaveBeenCalled();
        offU(); offA(); u.mockClear(); a.mockClear(); await tick(); f.updates.emit(state); f.activity.emit(feed); await tick(); expect(u).not.toHaveBeenCalled(); expect(a).not.toHaveBeenCalled();
    });
    it('page activity subscribed before ready survives recovery, with no preload fallback', async () => {
        const f = setup(), source = server(f.deps), port = source.port(); vi.stubGlobal('window', { genieLocalProtocol: port });
        const bridge = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge), received = vi.fn(), off = bridge.activity!.subscribe(received);
        await tick(); f.activity.emit(feed); await tick(); expect(received).toHaveBeenCalledTimes(1);
        port.send('close', '', ''); await tick(); expect(bridge.localProtocol!.state().phase).toBe('failed'); bridge.localProtocol!.retry(); await tick();
        f.activity.emit(feed); await tick(); expect(received).toHaveBeenCalledTimes(2); off(); await tick(); f.activity.emit(feed); await tick(); expect(received).toHaveBeenCalledTimes(2);
    });
    it('retires all three native event send/listen paths', () => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8');
        for (const channel of ['genie:updates-changed', 'genie:activity-changed', 'genie:headroom']) {
            expect(main).not.toContain(`send('${channel}'`); expect(main).not.toContain(`broadcast('${channel}'`); expect(preload).not.toContain(`ipcRenderer.on('${channel}'`);
        }
    });
});

describe('local event partition and per-view activity interest', () => {
    it.each(kinds)('%s receives no moved local events while a watching local window receives all three', async (kind) => {
        const f = setup(), source = server(f.deps), here = await admitted(source.raw(localProof)), there = await admitted(other(source, kind));
        expect(await here.call('activity.watch', 'view_a')).toMatchObject({ kind: 'result', ok: true }); here.clear(); there.clear();
        f.updates.emit(state); f.activity.emit(feed); f.headroom.emit(room); await tick();
        expect(here.events()).toEqual(expect.arrayContaining(localEvents.map((channel, i) => ({ kind: 'event', channel, payload: [state, feed, room][i] }))));
        expect(here.events()).toHaveLength(3); expect(there.events().some((frame) => localEvents.includes(frame.channel as typeof localEvents[number]))).toBe(false);
        if (kind === 'tailnet owner' || kind === 'relay owner') expect(there.events()).toEqual([{ kind: 'event', channel: 'updates', payload: state }, { kind: 'event', channel: 'activity', payload: feed }]);
        if (kind === 'workspace guest' || kind === 'host guest') expect(there.events()).toEqual([{ kind: 'event', channel: 'activity', payload: feed }]);
    });
    it('connection alone and reads send no activity frames, while updates/headroom still reach every local connection', async () => {
        const f = setup(), source = server(f.deps), here = await admitted(source.raw(localProof));
        expect(await here.call('activity', 'work')).toMatchObject({ kind: 'result', ok: true, value: { agent_a: feed } }); here.clear();
        f.activity.emit(feed); f.updates.emit(state); f.headroom.emit(room); await tick();
        expect(here.events()).toEqual([{ kind: 'event', channel: 'local-updates', payload: state }, { kind: 'event', channel: 'local-headroom', payload: room }]);
    });
    it('two independent views retain interest until the last unwatch; another local window remains silent', async () => {
        const f = setup(), source = server(f.deps), here = await admitted(source.raw(localProof)), other = await admitted(source.raw(localProof));
        expect(await here.call('activity.watch', 'a')).toMatchObject({ kind: 'result', ok: true }); expect(await here.call('activity.watch', 'b')).toMatchObject({ kind: 'result', ok: true });
        expect(await here.call('activity.unwatch', 'a')).toMatchObject({ kind: 'result', ok: true }); here.clear(); f.activity.emit(feed); await tick();
        expect(here.events()).toEqual([{ kind: 'event', channel: 'local-activity', payload: feed }]); expect(other.events()).toEqual([]);
        expect(await here.call('activity.unwatch', 'b')).toMatchObject({ kind: 'result', ok: true }); here.clear(); f.activity.emit(feed); await tick(); expect(here.events()).toEqual([]);
    });
    it('duplicate watch is idempotent, and close releases all view interest before a fresh connection', async () => {
        const f = setup(), source = server(f.deps), here = await admitted(source.raw(localProof));
        expect(await here.call('activity.watch', 'a')).toMatchObject({ kind: 'result', ok: true }); expect(await here.call('activity.watch', 'a')).toMatchObject({ kind: 'result', ok: true });
        expect(await here.call('activity.unwatch', 'a')).toMatchObject({ kind: 'result', ok: true }); here.clear(); f.activity.emit(feed); await tick(); expect(here.events()).toEqual([]);
        await here.call('activity.watch', 'b'); here.close(); await tick(); const fresh = await admitted(source.raw(localProof)); f.activity.emit(feed); await tick(); expect(fresh.events()).toEqual([]);
    });
    it.each([undefined, null, false, 12, {}, [], ''])('malformed view id %j neither adds activity interest nor calls the API', async (raw) => {
        const f = setup(), source = server(f.deps), here = await admitted(source.raw(localProof));
        for (const method of ['activity.watch', 'activity.unwatch']) expect(await here.call(method, raw)).toMatchObject({ kind: 'result', ok: false, reason: expect.any(String) });
        here.clear(); f.activity.emit(feed); await tick(); expect(here.events()).toEqual([]); expect(source.invoke).not.toHaveBeenCalled();
    });
    it('a real client gives each subscription its own watch and unwatch and leaves no frames after the last release', async () => {
        const f = setup(), source = server(f.deps), client = await source.connect(), a = vi.fn(), b = vi.fn();
        const offA = client.bridge.activity!.subscribe(a), offB = client.bridge.activity!.subscribe(b); await tick();
        f.activity.emit(feed); await tick(); expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
        offA(); await tick(); f.activity.emit(feed); await tick(); expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(2);
        offB(); await tick(); f.activity.emit(feed); await tick(); expect(b).toHaveBeenCalledTimes(2);
        expect(source.invoke).not.toHaveBeenCalled();
        expect(source.calls.map((call) => call.method)).toEqual(['activity.watch', 'activity.watch', 'activity.unwatch', 'activity.unwatch']);
        const aId = source.calls[0]!.args[0], bId = source.calls[1]!.args[0];
        expect(aId).toEqual(expect.any(String)); expect(bId).toEqual(expect.any(String)); expect(aId).not.toBe(bId);
        expect(source.calls[0]!.args).toEqual([aId]); expect(source.calls[1]!.args).toEqual([bId]); expect(source.calls[2]!.args).toEqual([aId]); expect(source.calls[3]!.args).toEqual([bId]);
    });
});

it('reads, delivered update events and a new connection never install a downloaded update', async () => {
    const quitAndInstall = vi.fn(), processes = vi.fn(() => []), kill = vi.fn(), defer = vi.fn();
    const port: UpdaterPort = { configure: () => {}, check: async () => ({ version: '2.0.0-beta.58' }), download: async () => {}, quitAndInstall };
    const updater = new UpdateHost({ port, installDir: dir, ownPid: 1, processes, kill, defer });
    const install = vi.spyOn(updater, 'install'), deps = protocolContractDeps(dir);
    deps.updates = { state: () => updater.state(), check: () => updater.check(), download: () => updater.download(), install: () => {
        const result = updater.install(); return result ? result.then((answer) => ({ report: answer.report })) : null;
    }, onChange: (listener) => updater.onChange(listener) };
    Object.assign(deps.updates, { notes: () => updater.refreshNotes() });
    const source = server(deps), first = await source.connect(), received = vi.fn(), off = first.bridge.updates.subscribe(received);
    await first.bridge.updates.state(); await first.bridge.updates.check(); await first.bridge.updates.download(); await first.bridge.updates.notes!(); await tick();
    expect(updater.state().phase).toBe('downloaded'); expect(received).toHaveBeenCalled(); off(); first.close(); await tick();
    const next = await source.connect(); expect((await next.bridge.updates.state()).phase).toBe('downloaded'); await next.bridge.updates.notes!();
    expect(install).not.toHaveBeenCalled(); expect(processes).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled(); expect(defer).not.toHaveBeenCalled(); expect(quitAndInstall).not.toHaveBeenCalled();
});
