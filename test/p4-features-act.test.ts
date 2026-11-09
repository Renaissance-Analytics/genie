import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_FRAME_LIMIT_BYTES, type LocalFramePort } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import * as picks from '../src/main/host-picks.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import type { FeatureData } from '../src/renderer/features.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

/*
 * P4 family 11's last two (Tynn #560, on CallContext #578): `features.act` and `features.picked` leave the window's IPC. The
 * host decides who may attach a picked path and who may answer a pairing, from what it admitted; the window's own
 * follow-ups (the feature state, the browser pane) still run for a window's action, and never for another device's.
 */
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const closers: Array<() => void> = [];
let dir: string;
let devices: DeviceStore;

function serve(api: HostApi) {
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'act-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (l) => { accept = l; return () => {}; } } });
    const framePort = (window: 'main' | 'remote' = 'main') => {
        const pair = inMemoryPair();
        closers.push(() => pair.client.close());
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        const frames: number[] = [];
        let closedForCap = false;
        pair.client.onMessage((text) => {
            frames.push(Buffer.byteLength(text, 'utf8'));
            if (Buffer.byteLength(text, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) { closedForCap = true; pair.client.close(); return; }
            for (const l of listeners) l('frame', handle, text);
        });
        pair.client.onClose(() => { for (const l of listeners) l('closed', handle, ''); });
        const port: LocalFramePort = {
            onFrame: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
            send: (action, id, text) => {
                if (action === 'open') { handle = id; accept({ ...pair.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false, window } }); }
                else if (action === 'frame') {
                    if (Buffer.byteLength(text, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) { closedForCap = true; pair.client.close(); return; }
                    pair.client.send(text);
                } else pair.client.close();
            },
        };
        return { port, frames, closedForCap: () => closedForCap };
    };
    const connectRelay = async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'pat', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'relay' }, 'pat');
        closers.push(() => client.close());
        expect(await client.ready).toEqual({ ok: true });
        return client;
    };
    return { framePort, connectRelay };
}

function host(result: FeatureData = { knowledge: { hits: null } } as unknown as FeatureData) {
    const deps: HostApiDeps = protocolContractDeps(dir);
    const act = vi.fn(async (..._a: unknown[]) => result);
    const picked = vi.fn();
    Object.assign(deps.features, { act, picked });
    return { api: buildHostApi(deps), act, picked };
}
const preloadWith = (features: object) => ({ snapshot: async () => ({ workspaces: null }), subscribeAgentWire: () => () => {}, workspaces: {}, features }) as unknown as PreloadBridge;
const bridgeOn = (port: LocalFramePort, features: object = {}) => { vi.stubGlobal('window', { genieLocalProtocol: port }); return pageBridge(preloadWith(features)); };

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-p4-act-')); let n = 0; devices = await DeviceStore.open(dir, { now: Date.now, random: () => `act-${++n}` }); });
afterEach(async () => { for (const c of closers.splice(0)) c(); vi.unstubAllGlobals(); await settle(); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

describe('an action from this machine\'s own window', () => {
    it('crosses the door, not the preload, and the host says who sent it', async () => {
        const h = host();
        const old = vi.fn();
        const bridge = bridgeOn(serve(h.api).framePort().port, { act: old, picked: old });
        await bridge.features.act({ kind: 'knowledge.search', query: 'q' } as never);
        expect(old).not.toHaveBeenCalled();
        expect(h.act).toHaveBeenCalledExactlyOnceWith({ kind: 'knowledge.search', query: 'q' }, expect.objectContaining({ origin: 'local-window', isOwner: true }));
    });

    it('its result can be over 1 MiB: whole, no frame over the cap, the connection up', async () => {
        const big = { knowledge: { hits: null }, inbox: { unread: [{ text: 'x'.repeat(1_500_000) }] } } as unknown as FeatureData;
        const h = host(big);
        const door = serve(h.api).framePort();
        const bridge = bridgeOn(door.port);
        expect(await bridge.features.act({ kind: 'knowledge.search', query: 'q' } as never)).toEqual(big);
        expect(door.closedForCap()).toBe(false);
        expect(Math.max(...door.frames)).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
        expect((await bridge.localProtocol!.state()).phase).toBe('ready');
    });

    it('one too large for a frame is refused with a reason, before it can end the connection', async () => {
        const h = host();
        const door = serve(h.api).framePort();
        const bridge = bridgeOn(door.port);
        await expect(bridge.features.act({ kind: 'knowledge.add', text: 'y'.repeat(1_100_000) } as never)).rejects.toThrow(/too large/);
        expect(door.closedForCap()).toBe(false);
        expect(h.act).not.toHaveBeenCalled();
        // CONTROL: the connection is still there for a small one.
        await bridge.features.act({ kind: 'knowledge.search', query: 'q' } as never);
        expect(h.act).toHaveBeenCalledOnce();
    });

    it('it answers a pairing: Allow is pressed on this machine\'s own screen', async () => {
        const h = host();
        const bridge = bridgeOn(serve(h.api).framePort().port);
        await bridge.features.act({ kind: 'remote.answerPair', id: 'p1', allow: true } as never);
        expect(h.act).toHaveBeenCalledOnce();
    });

    it('CONTROL: a window driving another machine, and a relay guest, cannot answer one', async () => {
        const h = host();
        const source = serve(h.api);
        const bridge = bridgeOn(source.framePort('remote').port);
        await expect(bridge.features.act({ kind: 'remote.answerPair', id: 'p1', allow: true } as never)).rejects.toThrow(/own screen/);
        const relay = await source.connectRelay();
        await expect(relay.bridge.features.act({ kind: 'remote.answerPair', id: 'p1', allow: true } as never)).rejects.toThrow(/own screen/);
        expect(h.act).not.toHaveBeenCalled();
    });
});

describe('what the host\'s file picker picked', () => {
    it('this machine\'s own window reports it through the door', async () => {
        const h = host();
        const old = vi.fn();
        const bridge = bridgeOn(serve(h.api).framePort().port, { picked: old });
        await bridge.features.picked!(['/w/picked.txt']);
        expect(old).not.toHaveBeenCalled();
        expect(h.picked).toHaveBeenCalledExactlyOnceWith(['/w/picked.txt']);
    });

    it('a window driving another machine reports nothing that counts', async () => {
        const h = host();
        const bridge = bridgeOn(serve(h.api).framePort('remote').port);
        await bridge.features.picked!(['/w/picked.txt']).catch(() => {});
        expect(h.picked).not.toHaveBeenCalled();
    });
});

describe('the window\'s own follow-ups', () => {
    const isWindow = (c: unknown) => (picks as unknown as { isWindowCaller(c: unknown): boolean }).isWindowCaller(c);
    it('run for a window\'s action, and never for another device\'s or nobody\'s', () => {
        expect(isWindow({ origin: 'local-window' })).toBe(true);
        expect(isWindow({ origin: 'remote-window' })).toBe(true);
        for (const other of [{ origin: 'device' }, { origin: 'relay' }, undefined]) expect(isWindow(other)).toBe(false);
    });
});

describe('the IPC path is gone', () => {
    const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
    const main = read('main/main.ts');
    it('no native handler, no preload line, no inventory row for an action or a pick', () => {
        expect(main).not.toContain('FEATURE_CHANNELS.act');
        expect(main).not.toContain('FEATURE_CHANNELS.picked');
        const preload = read('main/preload.ts');
        expect(preload).not.toContain('FEATURE_CHANNELS.act');
        expect(preload).not.toContain('FEATURE_CHANNELS.picked');
        const inventory = read('core/ipc-inventory.ts');
        expect(inventory).not.toContain('genie:features-act');
        expect(inventory).not.toContain('genie:features-picked');
    });
    it('the host\'s act does the window\'s follow-ups, only for a window, and the pick is the host\'s', () => {
        expect(main).toMatch(/isWindowCaller\(context\)/);
        expect(main).toMatch(/picked: \(paths\) => hostPicks\.record\(paths\)/);
    });
});
