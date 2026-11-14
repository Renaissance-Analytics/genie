import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../src/core/catalog.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, LOCAL_EVENTS, type ControlMethod, type PreAuth, type RemoteMethod, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import type { TynnWatchEvent, TynnWatchKind } from '../src/core/local-tynn-watch.js';
import { builtinToolPackage } from '../src/main/genie-catalog.js';
import { buildHostApi } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import type { GenieBridge } from '../src/renderer/bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

// The routing/removal landed in d4e69a16. These additional controls need measured break probes,
// followed by exact restoration; an initial GREEN alone does not prove their sensitivity (Tynn #561).
const rows = [
    { name: 'tynnBoard', args: ['work', {}] },
    { name: 'tynnBoardAction', args: ['work', { action: 'move' }] },
    { name: 'tynnPage', args: ['work', 'wip', {}] },
    { name: 'tynnPageAction', args: ['work', { action: 'save' }] },
    { name: 'tynnBoardChanges', args: ['work', {}, 'cursor', []] },
    { name: 'tynnIssues', args: ['work', {}] },
    { name: 'tynnIssueAction', args: ['work', { action: 'close', issueId: 'i1' }] },
    { name: 'tynnIssueChanges', args: ['work', {}, 'cursor', []] },
] as const;
const kinds = ['board', 'issues', 'features'] as const;
const watchNames = { board: 'tynnBoardWatch', issues: 'tynnIssuesWatch', features: 'tynnFeaturesWatch' } as const;
const call = (ws: GenieBridge['workspaces'], row: typeof rows[number]) =>
    (ws[row.name] as (...args: readonly unknown[]) => Promise<unknown>)(...row.args);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
let dir: string, devices: DeviceStore;
const clients: RemoteClient[] = [];

function fixture() {
    const listeners = new Set<(event: TynnWatchEvent) => void>();
    const watched = new Map<string, { kind: TynnWatchKind; workspaceId: string }>();
    const tynn = {
        watch: vi.fn(async (kind: TynnWatchKind, viewId: string, workspaceId: string) => {
            watched.set(viewId, { kind, workspaceId }); return true;
        }),
        unwatch: vi.fn((_kind: TynnWatchKind, viewId: string) => { watched.delete(viewId); }),
        subscribe: (listener: (event: TynnWatchEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const deps = Object.assign(protocolContractDeps(dir), { tynnWatch: tynn });
    const operation = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
    for (const row of rows) Object.assign(deps.workspaceOps, { [row.name]: operation });
    const api = buildHostApi(deps), invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'family12-host', devices, baton: new Baton(), pins: new PairingPins({ now: Date.now }),
        confirm: allowEveryPairing, transport: { onConnection: listener => { accept = listener; return () => {}; } },
    });
    const connect = async (peer: 'local' | 'owner' | 'guest' | 'readonly' = 'local') => {
        const pair = inMemoryPair(), frames: WireMessage[] = [];
        const pending = new Map<number, (message: Extract<WireMessage, { kind: 'result' }>) => void>();
        let sequence = 100_000;
        pair.client.onMessage(text => {
            const message = JSON.parse(text) as WireMessage; frames.push(message);
            if (message.kind === 'result') { pending.get(message.id)?.(message); pending.delete(message.id); }
        });
        const preAuth: PreAuth = { kind: peer === 'local' ? 'local' : 'relay', label: peer,
            isOwner: peer === 'local' || peer === 'owner', workspaceId: peer === 'guest' || peer === 'readonly' ? 'work' : null, readonly: peer === 'readonly' };
        accept({ ...pair.server, preAuth });
        const client = connectRemote(pair.client, { kind: peer === 'local' ? 'local' : 'relay' }, peer);
        clients.push(client);
        expect(await client.ready).toEqual({ ok: true });
        return Object.assign(client, {
            frames,
            events: () => frames.filter(message => message.kind === 'event' && message.channel === LOCAL_EVENTS.tynn),
            raw: (method: RemoteMethod | ControlMethod, ...args: unknown[]) => new Promise<Extract<WireMessage, { kind: 'result' }>>(resolve => {
                const id = ++sequence; pending.set(id, resolve);
                pair.client.send(JSON.stringify({ kind: 'call', id, method, args }));
            }),
        });
    };
    return { operation, invoke, tynn, watched, connect,
        emit: (kind: TynnWatchKind, workspaceId: string, signal: unknown) => {
            for (const listener of listeners) listener({ kind, workspaceId, signal });
        },
        delayWatch: (gate: ReturnType<typeof deferred>) => tynn.watch.mockImplementation(async (kind, viewId, workspaceId) => {
            await gate.promise; watched.set(viewId, { kind, workspaceId }); return true;
        }),
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-family12-kept-'));
    let sequence = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family12-kept-${++sequence}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await settle();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('the Tynn tab keeps caller answers', () => {
    it.each(rows)('$name preserves an explicit null answer', async row => {
        const source = fixture(), client = await source.connect();
        expect(await call(client.bridge.workspaces, row)).toBeNull();
        expect(source.operation).toHaveBeenCalledExactlyOnceWith(...row.args);
        expect(source.invoke).toHaveBeenCalledWith(`workspaces.${row.name}`, [...row.args], expect.anything());
    });

    it.each(rows)('$name exposes an API failure in its existing refusal shape', async row => {
        const source = fixture(), client = await source.connect(), reason = `${row.name} cannot answer now`;
        source.operation.mockRejectedValue(new Error(reason));
        expect(await call(client.bridge.workspaces, row)).toEqual({ ok: false, reason });
        expect(source.operation).toHaveBeenCalledExactlyOnceWith(...row.args);
    });
});

describe('the host keeps watch permissions even when the client does not offer the method', () => {
    it.each(['owner', 'guest', 'readonly'] as const)('%s cannot open a local Tynn watch over its remote connection', async peer => {
        const source = fixture(), client = await source.connect(peer);
        expect(await client.raw('tynn.watch', 'board', 'work')).toMatchObject({ ok: false, reason: expect.stringContaining('own Genie window') });
        expect(source.tynn.watch).not.toHaveBeenCalled();
        source.emit('board', 'work', { changed: true }); await settle();
        expect(client.events()).toEqual([]);
    });

    it.each(['owner', 'guest', 'readonly'] as const)('%s cannot release a local Tynn watch over its remote connection', async peer => {
        const source = fixture(), local = await source.connect(), client = await source.connect(peer);
        const opened = await local.raw('tynn.watch', 'board', 'work');
        expect(opened).toMatchObject({ ok: true, value: expect.any(Number) });
        expect(await client.raw('tynn.unwatch', opened.ok ? opened.value : null)).toMatchObject({ ok: false, reason: expect.stringContaining('own Genie window') });
        expect(source.tynn.unwatch).not.toHaveBeenCalled();
        expect(source.watched.size).toBe(1);
    });
});

describe('a view owns only its Tynn watches', () => {
    it('another local window cannot release this window\'s watch, and its own release succeeds', async () => {
        const source = fixture(), a = await source.connect(), b = await source.connect();
        const opened = await a.raw('tynn.watch', 'board', 'work');
        expect(opened).toMatchObject({ ok: true, value: expect.any(Number) });
        const id = opened.ok ? opened.value : null;
        expect(await b.raw('tynn.unwatch', id)).toMatchObject({ ok: true, value: { unwatched: false } });
        expect(source.watched.size).toBe(1);
        expect(source.tynn.unwatch).not.toHaveBeenCalled();
        expect(await a.raw('tynn.unwatch', id)).toMatchObject({ ok: true, value: { unwatched: true } });
        expect(source.watched.size).toBe(0);
        expect(source.tynn.unwatch).toHaveBeenCalledTimes(1);
    });

    it.each(kinds)('%s: stopping before opening completes releases the late watch', async kind => {
        const source = fixture(), gate = deferred(), client = await source.connect(); source.delayWatch(gate);
        const heard = vi.fn(), stop = client.bridge.workspaces[watchNames[kind]]!('work', heard);
        await settle(); expect(source.tynn.watch).toHaveBeenCalledTimes(1);
        stop(); gate.resolve(); await settle();
        expect(source.tynn.unwatch).toHaveBeenCalledExactlyOnceWith(kind, source.tynn.watch.mock.calls[0]![1]);
        expect(source.watched.size).toBe(0);
        const before = client.events().length;
        source.emit(kind, 'work', { changed: true }); await settle();
        expect(client.events()).toHaveLength(before); expect(heard).not.toHaveBeenCalled();
    });

    it.each(kinds)('%s: disconnecting before opening completes releases the late watch', async kind => {
        const source = fixture(), gate = deferred(), client = await source.connect(); source.delayWatch(gate);
        client.bridge.workspaces[watchNames[kind]]!('work', vi.fn());
        await settle(); expect(source.tynn.watch).toHaveBeenCalledTimes(1);
        client.close(); gate.resolve(); await settle();
        expect(source.tynn.unwatch).toHaveBeenCalledExactlyOnceWith(kind, source.tynn.watch.mock.calls[0]![1]);
        expect(source.watched.size).toBe(0);
    });

    it.each(kinds)('%s: an unavailable watch retains no membership and sends no signal', async kind => {
        const source = fixture(), client = await source.connect(); source.tynn.watch.mockResolvedValue(false);
        const heard = vi.fn(), stop = client.bridge.workspaces[watchNames[kind]]!('work', heard);
        await settle(); expect(source.tynn.watch).toHaveBeenCalledTimes(1);
        expect(source.watched.size).toBe(0);
        const before = client.events().length;
        source.emit(kind, 'work', { changed: true }); await settle(); stop(); await settle();
        expect(client.events()).toHaveLength(before); expect(heard).not.toHaveBeenCalled();
        expect(source.tynn.unwatch).not.toHaveBeenCalled();
    });

    it('an unwatched workspace produces no frame; the watched workspace is a positive control', async () => {
        const source = fixture(), client = await source.connect(), heard = vi.fn();
        const stop = client.bridge.workspaces.tynnBoardWatch!('work', heard);
        await settle(); expect(source.watched.size).toBe(1);
        const before = client.events().length;
        source.emit('board', 'other', { changed: true }); await settle();
        expect(client.events()).toHaveLength(before); expect(heard).not.toHaveBeenCalled();
        source.emit('board', 'work', { changed: true }); await settle();
        expect(client.events()).toHaveLength(before + 1);
        expect(heard).toHaveBeenCalledExactlyOnceWith({ changed: true });
        stop(); await settle(); expect(source.watched.size).toBe(0);
    });
});

it('the real Tynn tab is one builtin page with its exact two-sided protocol link', () => {
    const catalog = new Catalog();
    expect(catalog.register(builtinToolPackage([]))).toMatchObject({ ok: true });
    const page = catalog.get('genie.tynn');
    expect(page).not.toBeNull();
    expect(page).toMatchObject({ kind: 'page', source: 'builtin', packageId: 'ai.genie.core',
        reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local' },
    });
    expect(page!.reach.link?.calls.slice().sort()).toEqual([
        ...rows.map(row => `workspaces.${row.name}`), 'tynn.watch', 'tynn.unwatch',
    ].sort());
    expect(page!.reach.link?.events).toEqual([LOCAL_EVENTS.tynn]);
    expect(catalog.list('page').filter(item => item.id === 'genie.tynn')).toHaveLength(1);
});
