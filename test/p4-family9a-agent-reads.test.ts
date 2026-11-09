import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_FRAME_LIMIT_BYTES, type LocalFramePort } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

/*
 * P4 FAMILY 9A (Tynn #564), the hottest path: the snapshot, an agent's detail and its watch over the local door. Only the agents
 * a view shows are built or sent, a patch is as small as IPC's, and no frame reaches the door's cap, however long the ledger.
 */
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const closers: Array<() => void> = [];
let dir: string;
let devices: DeviceStore;
type Row = { id: string; text: string };

function serve(api: HostApi) {
    let accept!: (c: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'read-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: { onConnection: (l) => { accept = l; return () => {}; } } });
    /** A window's door; each open is a new connection, as a reconnect is. `frames` is everything the host sent, by size. */
    const door = () => {
        const frames: number[] = [], texts: string[] = [];
        let handle = '';
        let closeCurrent = () => {};
        let write: (t: string) => void = () => {};
        let overCap = false;
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        const port: LocalFramePort = {
            onFrame: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
            send: (action, id, text) => {
                if (action === 'open') {
                    const pair = inMemoryPair();
                    handle = id;
                    pair.client.onMessage((t) => {
                        frames.push(Buffer.byteLength(t, 'utf8')); texts.push(t);
                        if (Buffer.byteLength(t, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) { overCap = true; pair.client.close(); return; }
                        for (const l of listeners) l('frame', handle, t);
                    });
                    pair.client.onClose(() => { for (const l of listeners) l('closed', handle, 'closed'); });
                    closeCurrent = () => pair.client.close();
                    closers.push(closeCurrent);
                    write = (t: string) => pair.client.send(t);
                    accept({ ...pair.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false, window: 'main' } });
                } else if (action === 'frame') write(text);
                else closeCurrent();
            },
        };
        return { port, frames, texts, overCap: () => overCap, drop: () => closeCurrent() };
    };
    const relay = async () => {
        const pair = inMemoryPair();
        const inbox: WireMessage[] = [];
        pair.client.onMessage((t) => { const r = parseMessage(t); if (r.ok) inbox.push(r.message); });
        closers.push(() => pair.client.close());
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'pat', isOwner: true, workspaceId: null, readonly: false } });
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' } }));
        await vi.waitFor(() => expect(inbox.some((m) => m.kind === 'welcome')).toBe(true));
        return inbox;
    };
    return { door, relay };
}

function host() {
    const deps: HostApiDeps = protocolContractDeps(dir);
    const ledgers = new Map<string, Row[]>();
    const changed = new Set<(id: string) => void>();
    const snapshotListeners = new Set<(s: unknown) => void>();
    let snap: unknown = { agents: [], workspaces: [], deckItems: [], signals: {} };
    const detailFor = vi.fn((id: string) => (ledgers.has(id) ? { agent: { id }, rows: ledgers.get(id)! } : null));
    const snapshot = vi.fn(() => snap);
    Object.assign(deps, {
        detailFor, snapshot, find: (id: string) => (ledgers.has(id) ? { id, workspaceId: 'work', provider: 'claude', name: id } : null),
        subscribeSnapshot: (l: (s: unknown) => void) => { snapshotListeners.add(l); return () => snapshotListeners.delete(l); },
    });
    Object.assign(deps.host, { subscribe: (l: (id: string) => void) => { changed.add(l); return () => changed.delete(l); } });
    return {
        api: buildHostApi(deps), detailFor, snapshot, ledgers,
        change: (id: string) => { for (const l of changed) l(id); },
        pushSnapshot: (next: unknown) => { snap = next; for (const l of snapshotListeners) l(next); },
    };
}
const rowsOf = (n: number, size = 8): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: 'x'.repeat(size) }));
const preload = () => ({ snapshot: vi.fn(async () => { throw new Error('old native path'); }), agentDetail: vi.fn(async () => { throw new Error('old native path'); }), subscribe: vi.fn(() => () => {}), subscribeAgentWire: vi.fn(() => () => {}), workspaces: {}, features: {} }) as unknown as PreloadBridge;
const bridgeOn = (port: LocalFramePort, old: PreloadBridge = preload()) => { vi.stubGlobal('window', { genieLocalProtocol: port }); return pageBridge(old); };
const agentFrames = (texts: readonly string[]) => texts.filter((t) => t.includes('"channel":"local-agent"'));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-p4-9a-')); let n = 0; devices = await DeviceStore.open(dir, { now: Date.now, random: () => `r-${++n}` }); });
afterEach(async () => { for (const c of closers.splice(0)) c(); vi.unstubAllGlobals(); await settle(); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

describe('M2: only the agents a view shows', () => {
    it('an agent no view shows is never built and never sent', async () => {
        const h = host();
        h.ledgers.set('a1', rowsOf(3)); h.ledgers.set('a2', rowsOf(3));
        const d = serve(h.api).door();
        const heard: unknown[] = [];
        bridgeOn(d.port).subscribeAgent('a1', (x) => heard.push(x));
        await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
        h.detailFor.mockClear();
        d.texts.length = 0;
        h.change('a2');
        h.change('a1');
        await wait(120);
        expect(h.detailFor.mock.calls.map(([id]) => id)).toEqual(['a1']);
        expect(d.texts.some((t) => t.includes('a2'))).toBe(false);
    });

    it('CONTROL: a remote connection hears every agent, so the same change builds it', async () => {
        const h = host();
        h.ledgers.set('a2', rowsOf(3));
        await serve(h.api).relay();
        h.change('a2');
        await vi.waitFor(() => expect(h.detailFor).toHaveBeenCalledWith('a2'));
    });

    it('a view that leaves stops the pushes', async () => {
        const h = host();
        h.ledgers.set('a1', rowsOf(3));
        const off = bridgeOn(serve(h.api).door().port).subscribeAgent('a1', () => {});
        await vi.waitFor(() => expect(h.detailFor).toHaveBeenCalled());
        off();
        await settle();
        await wait(60);
        h.detailFor.mockClear();
        h.change('a1');
        await wait(120);
        expect(h.detailFor).not.toHaveBeenCalled();
    });
});

describe('M1: a patch is as cheap as the IPC one', () => {
    it('a long ledger, one new row: the frame carries that row and not the ledger', async () => {
        const h = host();
        const rows = rowsOf(5000, 80);
        h.ledgers.set('a1', rows);
        const d = serve(h.api).door();
        const heard: Array<{ rows: readonly Row[] } | null> = [];
        bridgeOn(d.port).subscribeAgent('a1', (x) => heard.push(x as never));
        await vi.waitFor(() => expect(heard.at(-1)?.rows).toHaveLength(5000));
        await wait(60);
        d.texts.length = 0;
        rows.push({ id: 'new', text: 'just this' });
        h.change('a1');
        await vi.waitFor(() => expect(heard.at(-1)?.rows).toHaveLength(5001));
        expect(agentFrames(d.texts)).toHaveLength(1);
        // IPC's payload is { seq, detail, rows: { base, keep, append } }; the door adds a fixed envelope.
        const payload = JSON.stringify({ seq: 2, detail: { agent: { id: 'a1' } }, rows: { base: 1, keep: 5000, append: [{ id: 'new', text: 'just this' }] } });
        expect(Buffer.byteLength(agentFrames(d.texts)[0]!)).toBeLessThanOrEqual(Buffer.byteLength(payload) + 100);
    });
});

describe('M3: nothing reaches the frame cap', () => {
    it('a ledger over 1 MiB arrives whole, no frame over the cap, the connection up', async () => {
        const h = host();
        h.ledgers.set('a1', rowsOf(6000, 400));
        const d = serve(h.api).door();
        const b = bridgeOn(d.port);
        const heard: Array<{ rows: readonly Row[] } | null> = [];
        b.subscribeAgent('a1', (x) => heard.push(x as never));
        await vi.waitFor(() => expect(heard.at(-1)?.rows).toHaveLength(6000), { timeout: 10_000 });
        expect(d.overCap()).toBe(false);
        expect(Math.max(...d.frames)).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
        expect(b.localProtocol!.state().phase).toBe('ready');
    });

    it('a single patch over 1 MiB arrives, and the patch after it still applies', async () => {
        const h = host();
        const rows = rowsOf(2);
        h.ledgers.set('a1', rows);
        const d = serve(h.api).door();
        const heard: Array<{ rows: readonly Row[] } | null> = [];
        bridgeOn(d.port).subscribeAgent('a1', (x) => heard.push(x as never));
        await vi.waitFor(() => expect(heard.at(-1)?.rows).toHaveLength(2));
        await wait(60);
        rows.push({ id: 'big', text: 'y'.repeat(1_500_000) });
        h.change('a1');
        await vi.waitFor(() => expect(heard.at(-1)?.rows).toHaveLength(3), { timeout: 10_000 });
        await wait(60);
        rows.push({ id: 'after', text: 'z' });
        h.change('a1');
        await vi.waitFor(() => expect(heard.at(-1)?.rows.map((r) => r.id)).toEqual(['r0', 'r1', 'big', 'after']), { timeout: 10_000 });
        expect(d.overCap()).toBe(false);
    });

    it('a read of an agent or the snapshot over 1 MiB comes whole', async () => {
        const h = host();
        h.ledgers.set('a1', rowsOf(6000, 400));
        const big = { agents: [{ id: 'x', text: 'q'.repeat(1_500_000) }], workspaces: [], deckItems: [], signals: {} };
        h.pushSnapshot(big);
        const d = serve(h.api).door();
        const old = preload();
        const b = bridgeOn(d.port, old);
        expect(((await b.agentDetail('a1')) as unknown as { rows: Row[] }).rows).toHaveLength(6000);
        expect(await b.snapshot()).toEqual(big);
        expect(old.snapshot).not.toHaveBeenCalled();
        expect(old.agentDetail).not.toHaveBeenCalled();
        expect(d.overCap()).toBe(false);
    });
});

describe('the snapshot push', () => {
    it('inline when it fits: the listener has it with no read', async () => {
        const h = host();
        const b = bridgeOn(serve(h.api).door().port);
        const heard: unknown[] = [];
        b.subscribe((s) => heard.push(s));
        await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
        h.snapshot.mockClear();
        const next = { agents: [{ id: 'one' }], workspaces: [], deckItems: [], signals: {} };
        h.pushSnapshot(next);
        await vi.waitFor(() => expect(heard.at(-1)).toEqual(next));
        expect(h.snapshot).not.toHaveBeenCalled();
    });

    it('over the frame: a revision, and the window reads it whole; no frame over the cap', async () => {
        const h = host();
        const d = serve(h.api).door();
        const b = bridgeOn(d.port);
        const heard: unknown[] = [];
        b.subscribe((s) => heard.push(s));
        await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
        const big = { agents: [{ id: 'x', text: 'q'.repeat(1_500_000) }], workspaces: [], deckItems: [], signals: {} };
        h.pushSnapshot(big);
        await vi.waitFor(() => expect(heard.at(-1)).toEqual(big), { timeout: 10_000 });
        expect(d.overCap()).toBe(false);
        expect(Math.max(...d.frames)).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
    });
});

describe('M7: a window that reconnects', () => {
    it('gets the whole ledger again, nothing missed and nothing doubled, and the snapshot it missed', async () => {
        const h = host();
        const rows = rowsOf(3);
        h.ledgers.set('a1', rows);
        const d = serve(h.api).door();
        const b = bridgeOn(d.port);
        const ledger: Array<{ rows: readonly Row[] } | null> = [];
        const snapshots: unknown[] = [];
        b.subscribeAgent('a1', (x) => ledger.push(x as never));
        b.subscribe((s) => snapshots.push(s));
        await vi.waitFor(() => expect(ledger.at(-1)?.rows).toHaveLength(3));
        d.drop();
        await vi.waitFor(() => expect(b.localProtocol!.state().phase).toBe('failed'));
        rows.push({ id: 'while-away', text: 'x' });
        const missed = { agents: [{ id: 'missed' }], workspaces: [], deckItems: [], signals: {} };
        h.pushSnapshot(missed);
        b.localProtocol!.retry();
        await vi.waitFor(() => expect(ledger.at(-1)?.rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'while-away']), { timeout: 10_000 });
        await vi.waitFor(() => expect(snapshots.at(-1)).toEqual(missed));
    });
});
