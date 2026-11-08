import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { LOCAL_EVENTS, inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { LOCAL_FRAME_LIMIT_BYTES, type LocalFramePort } from '../src/core/local-frame.js';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import type { FeatureData } from '../src/renderer/features.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * HOST SPLIT P4, FAMILY 11 (Tynn #560): the feature snapshot, a custom sound's data, and the push that says the snapshot
 * changed, on the one protocol. A snapshot has no bound (the unread mail and 200 recent messages ride in it) and the door
 * ends a window's whole connection on a frame over 1 MiB, so a snapshot crosses through the content path (inline when small,
 * a blob when not) and the push is a revision: the window re-reads, one read for a burst. No local event may carry a
 * whole snapshot, and one too large to send is dropped, never the connection.
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i += 1) await tick(); };
let dir: string;
let devices: DeviceStore;
const clients: RemoteClient[] = [];
const closePorts: Array<() => void> = [];

function serve(api: HostApi) {
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'family11-host', baton: new Baton(), devices,
        pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } },
    });
    /** A local window through a door that enforces the real frame cap, as local-protocol-door.ts does. */
    const framePort = () => {
        const pair = inMemoryPair();
        closePorts.push(() => pair.client.close());
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        const frames: number[] = [];
        let closedForCap = false;
        pair.client.onMessage((text) => {
            frames.push(Buffer.byteLength(text, 'utf8'));
            if (Buffer.byteLength(text, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) { closedForCap = true; pair.client.close(); return; }
            for (const listener of listeners) listener('frame', handle, text);
        });
        pair.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
        const port: LocalFramePort = {
            onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            send: (action, id, text) => {
                if (action === 'open') {
                    handle = id;
                    accept({ ...pair.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false } });
                } else if (action === 'frame') pair.client.send(text);
                else pair.client.close();
            },
        };
        return { port, frames, closedForCap: () => closedForCap };
    };
    const connectRelay = async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'pat', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'relay' }, 'pat');
        clients.push(client);
        expect(await client.ready).toEqual({ ok: true });
        return client;
    };
    return { framePort, connectRelay };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-family11-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family11-${++seq}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const close of closePorts.splice(0)) close();
    vi.unstubAllGlobals();
    await tick();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

function featureHost(initial: FeatureData) {
    const deps: HostApiDeps = protocolContractDeps(dir);
    let current = initial;
    const listeners = new Set<(d: FeatureData) => void>();
    const snapshot = vi.fn(async () => current);
    const soundData = vi.fn(async (key: string) => (key === 'none' ? null : `data:audio/wav;base64,${'A'.repeat(2_000_000)}`));
    Object.assign(deps.features, { snapshot, soundData, onChange: (cb: (d: FeatureData) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } });
    const api = buildHostApi(deps);
    return { api, snapshot, soundData, change: (next: FeatureData) => { current = next; for (const l of listeners) l(next); } };
}

const big = (n: number, seq = 1) => ({ seq, knowledge: { hits: null }, inbox: { unread: [{ id: 'm1', text: 'x'.repeat(n) }] }, remote: { pairRequests: [{ id: 'p1' }] } }) as unknown as FeatureData;
const preloadWith = (features: object) => ({ snapshot: async () => ({ workspaces: null }), subscribeAgentWire: () => () => {}, workspaces: {}, features }) as unknown as PreloadBridge;

describe('a feature snapshot over the door', () => {
    it('a snapshot over 1 MiB reaches the window intact, no frame over the cap, and the connection stays up', async () => {
        const host = featureHost(big(1_500_000));
        const source = serve(host.api);
        const door = source.framePort();
        vi.stubGlobal('window', { genieLocalProtocol: door.port });
        const old = vi.fn();
        const bridge = pageBridge(preloadWith({ snapshot: old, subscribe: old, soundData: old, act: old }));
        const got = await bridge.features.snapshot();
        expect(got).toEqual(big(1_500_000));
        expect(old).not.toHaveBeenCalled();
        expect(door.closedForCap()).toBe(false);
        expect(Math.max(...door.frames)).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
        expect((await bridge.localProtocol!.state()).phase).toBe('ready');
    });

    it('a small snapshot is the API\'s, and keeps what only this machine\'s own window may see (the pairing requests)', async () => {
        const host = featureHost(big(10));
        vi.stubGlobal('window', { genieLocalProtocol: serve(host.api).framePort().port });
        const bridge = pageBridge(preloadWith({}));
        expect(await bridge.features.snapshot()).toEqual(big(10));
    });

    it('CONTROL: a remote connection still gets it without the pairing requests', async () => {
        const host = featureHost(big(10));
        const relay = await serve(host.api).connectRelay();
        expect((await relay.bridge.features.snapshot() as unknown as { remote: { pairRequests: unknown[] } }).remote.pairRequests).toEqual([]);
    });
});

describe('the push is a revision; the window re-reads', () => {
    it('a window that just subscribed reads at once: a connection that was down missed revisions nobody will send again', async () => {
        const host = featureHost(big(10, 7));
        vi.stubGlobal('window', { genieLocalProtocol: serve(host.api).framePort().port });
        const bridge = pageBridge(preloadWith({}));
        const heard: FeatureData[] = [];
        bridge.features.subscribe((d) => heard.push(d));
        // No change is pushed: what it hears is the read a (re)subscribe makes.
        await vi.waitFor(() => expect(heard).toEqual([big(10, 7)]));
    });

    it('a change with a snapshot over 1 MiB: only small frames cross, the listener gets the whole snapshot, the connection stays up', async () => {
        const host = featureHost(big(10));
        const door = serve(host.api).framePort();
        vi.stubGlobal('window', { genieLocalProtocol: door.port });
        const bridge = pageBridge(preloadWith({}));
        await bridge.features.snapshot();
        const heard: FeatureData[] = [];
        bridge.features.subscribe((d) => heard.push(d));
        await settle();
        heard.length = 0;
        door.frames.length = 0;
        host.change(big(1_500_000, 2));
        await vi.waitFor(() => expect(heard).toHaveLength(1));
        expect(heard[0]).toEqual(big(1_500_000, 2));
        expect(door.closedForCap()).toBe(false);
        expect(Math.max(...door.frames)).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
    });

    it('a burst of changes is one re-read at a time, and the listener ends on the latest', async () => {
        const host = featureHost(big(10));
        vi.stubGlobal('window', { genieLocalProtocol: serve(host.api).framePort().port });
        const bridge = pageBridge(preloadWith({}));
        await bridge.features.snapshot();
        const heard: FeatureData[] = [];
        bridge.features.subscribe((d) => heard.push(d));
        await settle();
        host.snapshot.mockClear();
        for (let seq = 2; seq <= 11; seq += 1) host.change(big(10, seq));
        await vi.waitFor(() => expect((heard.at(-1) as unknown as { seq: number } | undefined)?.seq).toBe(11));
        await settle();
        // The first change's read, and one more for everything that came while it ran.
        expect(host.snapshot.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('CONTROL: a remote window still hears the whole snapshot on `features`', async () => {
        const host = featureHost(big(10));
        const relay = await serve(host.api).connectRelay();
        const heard: unknown[] = [];
        relay.bridge.features.subscribe((d) => heard.push(d));
        await settle();
        host.change(big(10, 7));
        await settle();
        expect((heard[0] as { seq: number }).seq).toBe(7);
    });
});

describe('a sound\'s data', () => {
    it('crosses the door, a 2 MB data URL whole; an unknown key stays null', async () => {
        const host = featureHost(big(10));
        const door = serve(host.api).framePort();
        vi.stubGlobal('window', { genieLocalProtocol: door.port });
        const bridge = pageBridge(preloadWith({}));
        expect(await bridge.features.soundData('alert')).toHaveLength('data:audio/wav;base64,'.length + 2_000_000);
        expect(await bridge.features.soundData('none')).toBeNull();
        expect(host.soundData).toHaveBeenCalledWith('alert');
        expect(door.closedForCap()).toBe(false);
    });
});

describe('the guard: no local event carries a whole snapshot, and none can end a connection', () => {
    function fakeApi() {
        const listeners = new Set<(channel: string, payload: unknown) => void>();
        const api: HostApi = { invoke: async () => ({}), onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, workspaceOfAgent: () => null };
        return { api, emit: (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); } };
    }

    it('the features push on the local channel is a revision and nothing else, whatever the snapshot', async () => {
        const source = await readFile(new URL('../src/main/host-api.ts', import.meta.url), 'utf8');
        expect(source).toMatch(/listener\(LOCAL_EVENTS\.features, \{ revision: [^}]*\}\)/);
        expect(source).not.toMatch(/listener\(LOCAL_EVENTS\.features, data\)/);
    });

    it('a local event too large to send is dropped and said; the connection stays up; a small one still arrives (CONTROL)', async () => {
        const fake = fakeApi();
        const door = serve(fake.api).framePort();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('window', { genieLocalProtocol: door.port });
        const bridge = pageBridge(preloadWith({}));
        await settle();
        const heard: unknown[] = [];
        bridge.updates.subscribe((s) => heard.push(s));
        await settle();
        fake.emit(LOCAL_EVENTS.updates, { phase: 'idle', notes: 'n'.repeat(2_000_000) });
        await settle();
        expect(door.closedForCap()).toBe(false);
        expect(heard).toEqual([]);
        expect(warn.mock.calls.some(([m]) => String(m).includes(LOCAL_EVENTS.updates))).toBe(true);
        fake.emit(LOCAL_EVENTS.updates, { phase: 'idle' });
        await vi.waitFor(() => expect(heard).toEqual([{ phase: 'idle' }]));
        warn.mockRestore();
    });
});

describe('the IPC path is gone', () => {
    const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    it('no native handler, no preload line, no inventory row for the snapshot or the sound; no broadcast of the snapshot to every window', async () => {
        const main = strip(await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
        const preload = strip(await readFile(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));
        expect(main).not.toMatch(/ipcMain\.handle\(FEATURE_CHANNELS\.(snapshot|soundData)/);
        expect(main).not.toContain('broadcast(FEATURE_CHANNELS.changed');
        expect(preload).not.toMatch(/FEATURE_CHANNELS\.(snapshot|soundData|changed)/);
        for (const channel of ['genie:features-snapshot', 'genie:features-sound-data']) expect(IPC_INVENTORY.map(([c]) => c)).not.toContain(channel);
    });
});
