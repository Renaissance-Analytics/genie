import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, LOCAL_EVENTS, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { buildHostApi } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { localTransport } from '../src/renderer/local-transport.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import type { GenieBridge } from '../src/renderer/bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

// Family 11 already landed. These controls need measured sensitivity probes and exact restoration (Tynn #560).
const state = (seq: number): FeatureData => ({ ...EMPTY_FEATURES, seq });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
let dir: string, devices: DeviceStore;
const clients: RemoteClient[] = [];

async function fixture() {
    let current = state(1);
    const changes = new Set<(data: FeatureData) => void>();
    const snapshot = vi.fn(async (): Promise<FeatureData> => current);
    const soundData = vi.fn(async (_key: string): Promise<string | null> => null);
    const act = vi.fn(async (): Promise<FeatureData> => current);
    const deps = protocolContractDeps(dir);
    Object.assign(deps.features, { snapshot, soundData, act, onChange: (listener: (data: FeatureData) => void) => {
        changes.add(listener); return () => { changes.delete(listener); };
    } });
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api: buildHostApi(deps), hostName: 'family11-kept-host', devices, baton: new Baton(),
        pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: listener => { accept = listener; return () => {}; } },
    });
    const pair = inMemoryPair(), frames: WireMessage[] = [];
    const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
    let handle = '';
    pair.client.onMessage(text => {
        frames.push(JSON.parse(text) as WireMessage);
        for (const listener of listeners) listener('frame', handle, text);
    });
    pair.client.onClose(() => { for (const listener of listeners) listener('closed', handle, 'closed'); });
    const port: LocalFramePort = {
        onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        send: (action, id, text) => {
            if (action === 'open') {
                handle = id;
                accept({ ...pair.server, preAuth: { kind: 'local', label: 'this window', isOwner: true, workspaceId: null, readonly: false, window: 'main' } });
            } else if (action === 'frame') pair.client.send(text);
            else pair.client.close();
        },
    };
    const client = connectRemote(localTransport(port), { kind: 'local' }, 'this window');
    clients.push(client);
    expect(await client.ready).toEqual({ ok: true });
    return { client, snapshot, soundData, act, current: () => current,
        events: () => frames.filter(message => message.kind === 'event' && message.channel === LOCAL_EVENTS.features),
        change: (next: FeatureData) => { current = next; for (const listener of changes) listener(next); },
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-family11-kept-'));
    let sequence = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family11-kept-${++sequence}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await settle();
    vi.restoreAllMocks();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('local feature callers keep unexpected operation failures', () => {
    // Pre-move main handlers and preload propagated a rejected operation. customSoundData's
    // ordinary missing/unreadable file is instead null, already covered by the existing suite.
    const rows: Array<{ name: 'snapshot' | 'soundData' | 'act'; call: (bridge: GenieBridge) => Promise<unknown> }> = [
        { name: 'snapshot', call: bridge => bridge.features.snapshot() },
        { name: 'soundData', call: bridge => bridge.features.soundData('sound_question') },
        { name: 'act', call: bridge => bridge.features.act({ kind: 'knowledge.search', query: 'fixture' }) },
    ];
    it.each(rows)('$name rejects with the reason instead of inventing a value', async row => {
        const source = await fixture(), reason = `${row.name} could not answer`;
        source[row.name].mockRejectedValue(new Error(reason));
        await expect(row.call(source.client.bridge)).rejects.toThrow(reason);
        expect(source[row.name]).toHaveBeenCalledTimes(1);
    });
});

it('a real local feature event contains only its revision, never the aggregate', async () => {
    const source = await fixture();
    source.change(state(2)); source.change(state(3)); await settle();
    expect(source.events()).toEqual([
        { kind: 'event', channel: LOCAL_EVENTS.features, payload: { revision: 1 } },
        { kind: 'event', channel: LOCAL_EVENTS.features, payload: { revision: 2 } },
    ]);
    expect(source.snapshot).not.toHaveBeenCalled();
});

it('a held read serializes a revision burst and delivers the newest state last', async () => {
    const source = await fixture(), gate = deferred<FeatureData>(), heard: FeatureData[] = [];
    let active = 0, maximum = 0;
    source.snapshot.mockImplementation(async () => {
        active++; maximum = Math.max(maximum, active);
        try { return source.snapshot.mock.calls.length === 1 ? await gate.promise : source.current(); }
        finally { active--; }
    });
    const stop = source.client.bridge.features.subscribe(data => { heard.push(data); });
    try {
        await settle(); expect(source.snapshot).toHaveBeenCalledTimes(1);
        for (let seq = 2; seq <= 6; seq++) source.change(state(seq));
        await settle(); expect(source.snapshot).toHaveBeenCalledTimes(1);
        gate.resolve(state(1)); await settle();
        expect(maximum).toBe(1); expect(active).toBe(0);
        expect(source.snapshot).toHaveBeenCalledTimes(2);
        expect(heard.map(data => data.seq)).toEqual([1, 6]);
    } finally { gate.resolve(state(1)); stop(); await settle(); }
});

it('no listeners cause no rereads, before subscription or after the last unsubscribe', async () => {
    const source = await fixture(), heard = vi.fn();
    source.change(state(2)); await settle(); expect(source.snapshot).not.toHaveBeenCalled();
    const stop = source.client.bridge.features.subscribe(heard);
    try {
        await settle(); expect(source.snapshot).toHaveBeenCalledTimes(1);
        expect(heard).toHaveBeenCalledExactlyOnceWith(state(2));
        stop(); source.change(state(3)); await settle();
        expect(source.snapshot).toHaveBeenCalledTimes(1); expect(heard).toHaveBeenCalledTimes(1);
    } finally { stop(); }
});

it('unsubscribing during a pending read prevents late delivery and later rereads', async () => {
    const source = await fixture(), gate = deferred<FeatureData>(), heard = vi.fn();
    source.snapshot.mockReturnValueOnce(gate.promise);
    const stop = source.client.bridge.features.subscribe(heard);
    try {
        await settle(); expect(source.snapshot).toHaveBeenCalledTimes(1);
        stop(); gate.resolve(state(1)); await settle();
        expect(heard).not.toHaveBeenCalled();
        source.change(state(2)); await settle();
        expect(source.snapshot).toHaveBeenCalledTimes(1); expect(heard).not.toHaveBeenCalled();
    } finally { gate.resolve(state(1)); stop(); await settle(); }
});

it('a failed reread reports its reason and a later revision recovers without invented state', async () => {
    const source = await fixture(), heard = vi.fn(), reason = 'the fixture snapshot could not be read';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    source.snapshot.mockRejectedValueOnce(new Error(reason));
    const stop = source.client.bridge.features.subscribe(heard);
    try {
        await settle(); expect(source.snapshot).toHaveBeenCalledTimes(1); expect(heard).not.toHaveBeenCalled();
        expect(warning.mock.calls.some(([message]) => String(message).includes(reason))).toBe(true);
        source.change(state(4)); await settle();
        expect(source.snapshot).toHaveBeenCalledTimes(2);
        expect(heard).toHaveBeenCalledExactlyOnceWith(state(4));
    } finally { stop(); }
});
