import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_FRAME_CHANNELS, LOCAL_FRAME_LIMIT_BYTES, type LocalFramePort, type LocalFrameReply } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, transportHub, type PreAuth, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { localProtocolDoor, type LocalDoorContents } from '../src/main/local-protocol-door.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { buildHostApi } from '../src/main/host-api.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { localTransport } from '../src/renderer/local-transport.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

// 7A adds only connection resources. No Files, draft or artboard bridge consumes them yet.
const CHUNK = 512 * 1024;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Kind = 'draft-file' | 'artboard-post' | 'workspace-file';
interface Source { size: number; sha256: string; read(offset: number, length: number): Promise<Uint8Array>; close(): Promise<void> }
interface Blobs {
    open(kind: Kind, ref: string): Promise<{ id: string; size: number; sha256: string }>;
    read(id: string, offset: number, length: number): Promise<{ base64: string }>;
    close(id: string): Promise<{ closed: boolean }>;
    readAll(kind: Kind, ref: string): Promise<Uint8Array>;
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

class Contents extends EventEmitter {
    mainFrame = { send: (_channel: string, _action: LocalFrameReply, _connection: string, _text: string) => {} };
    isDestroyed() { return false; }
}

async function fixture(size = 2 * 1024 * 1024 + 17) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-p4-blobs-'));
    let tokenSeq = 0;
    const devices = await DeviceStore.open(dir, { now: Date.now, random: () => `synthetic-blob-device-${++tokenSeq}` });
    const bytes = Uint8Array.from({ length: size }, (_, n) => n % 251);
    const sources: Array<Source & { read: ReturnType<typeof vi.fn<Source['read']>>; close: ReturnType<typeof vi.fn<Source['close']>> }> = [];
    const openBlob = vi.fn(async (_kind: Kind, ref: string): Promise<Source> => {
        if (ref !== 'ref_fixture') throw new Error('unknown blob reference');
        const source = { size: bytes.length, sha256: hash(bytes), read: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)), close: vi.fn(async () => {}) };
        sources.push(source); return source;
    });
    const api = buildHostApi(protocolContractDeps(dir)), invoke = vi.spyOn(api, 'invoke');
    const ipc = new EventEmitter(), door = localProtocolDoor(ipc);
    let acceptRemote!: (connection: ServerConnection) => void;
    const hub = transportHub({ onConnection: listener => { acceptRemote = listener; return () => {}; } }); hub.add(door);
    // A host-resolved immutable source port; no renderer path or asserted owner reaches it.
    new RemoteHost(Object.assign({ api, hostName: 'blob-fixture', devices, baton: new Baton(), pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: hub }, { openBlob }));
    const closes: Array<() => void> = [], serialized: string[] = [], calls: Array<{ method: string; args: unknown[] }> = [];
    const wire = { rewrite: (text: string) => text };
    cleanups.push(async () => { for (const close of closes) close(); door.dispose(); await tick(); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });
    function port() {
        const contents = new Contents(), listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        contents.mainFrame.send = (_channel, action, handle, text) => { const delivered = action === 'frame' ? wire.rewrite(text) : text; serialized.push(delivered); queueMicrotask(() => { for (const l of listeners) l(action, handle, delivered); }); };
        door.admit(contents as unknown as LocalDoorContents);
        const p: LocalFramePort = {
            onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            send: (action, handle, text) => { if (action === 'frame') { serialized.push(text); const m = JSON.parse(text); if (m.kind === 'call') calls.push(m); } queueMicrotask(() => ipc.emit(LOCAL_FRAME_CHANNELS.toHost, { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent, action, handle, text)); },
        };
        return p;
    }
    async function raw(proof: PreAuth | 'tailnet' | undefined = undefined, mobile = false) {
        const p = proof === undefined ? null : inMemoryPair();
        const transport = p?.client ?? localTransport(port());
        const frames: WireMessage[] = []; transport.onMessage(text => { frames.push(JSON.parse(text)); });
        closes.push(() => transport.close());
        if (p) acceptRemote({ ...p.server, ...(proof && proof !== 'tailnet' ? { preAuth: proof } : {}) });
        const auth = proof === undefined ? { kind: 'local' } : proof === 'tailnet' ? { kind: 'token', token: devices.pair('test owner').token } : { kind: 'relay' };
        transport.send(JSON.stringify({ kind: 'hello', auth, ...(mobile ? { profile: 'mobile' } : {}) })); await tick();
        expect(frames.some(f => f.kind === 'welcome')).toBe(true); await devices.flushed();
        let id = 0;
        const send = (method: string, args: unknown[]) => { const next = ++id; transport.send(JSON.stringify({ kind: 'call', id: next, method, args })); return next; };
        const result = (next: number) => frames.find((f): f is Extract<WireMessage, { kind: 'result' }> => f.kind === 'result' && f.id === next);
        return { transport, frames, send, result, async call(method: string, args: unknown[]) {
            const next = send(method, args); await tick(); const r = result(next);
            expect(r, `Expected a result for ${method}; received ${JSON.stringify(frames.filter(f => f.kind === 'refused'))}`).toBeDefined();
            return r!;
        } };
    }
    async function client(proof?: PreAuth) {
        const p = proof ? inMemoryPair() : null, transport = p?.client ?? localTransport(port());
        if (p && proof) acceptRemote({ ...p.server, preAuth: proof });
        const c = connectRemote(transport, { kind: proof ? 'relay' : 'local' }, 'blob-fixture');
        closes.push(() => c.close()); expect(await c.ready).toEqual({ ok: true }); return c;
    }
    return { bytes, sources, openBlob, invoke, raw, client, calls, serialized, wire };
}

function blobs(client: RemoteClient): Blobs {
    const port = (client as unknown as { blobs?: Blobs }).blobs;
    expect(port, 'the local client exposes connection-owned blob controls on its existing transport').toBeDefined(); return port!;
}
function value<T>(r: WireMessage): T { expect(r).toMatchObject({ kind: 'result', ok: true }); return (r as { value: T }).value; }

describe('7A standalone local blob controls through the admitted door', () => {
    it.each(['blob.open', 'blob.read', 'blob.close'])('%s is a recognized protocol control', method => {
        expect(parseMessage(JSON.stringify({ kind: 'call', id: 1, method, args: [] }))).toMatchObject({ ok: true, message: { method } });
    });
    it.each<Kind>(['draft-file', 'artboard-post', 'workspace-file'])('%s resolves a host reference and reads exact bounded bytes', async kind => {
        const f = await fixture(), c = await f.raw();
        const opened = value<{ id: string; size: number; sha256: string }>(await c.call('blob.open', [kind, 'ref_fixture']));
        expect(opened).toEqual({ id: expect.any(String), size: f.bytes.length, sha256: hash(f.bytes) });
        expect(f.openBlob).toHaveBeenCalledExactlyOnceWith(kind, 'ref_fixture');
        const parts: Buffer[] = [];
        for (let offset = 0; offset < opened.size; offset += CHUNK) {
            const length = Math.min(CHUNK, opened.size - offset);
            const r = value<{ base64: string }>(await c.call('blob.read', [opened.id, offset, length]));
            const part = Buffer.from(r.base64, 'base64'); expect(part.length).toBe(length); parts.push(part);
        }
        expect(new Uint8Array(Buffer.concat(parts))).toEqual(f.bytes);
        expect(value(await c.call('blob.close', [opened.id]))).toEqual({ closed: true });
        expect(f.sources[0]!.close).toHaveBeenCalledOnce(); expect(f.invoke).not.toHaveBeenCalled();
        expect(Math.max(...f.serialized.map(text => Buffer.byteLength(text, 'utf8')))).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
    });
    it('empty content has a real hash and a valid empty EOF read', async () => {
        const f = await fixture(0), c = await f.raw();
        const opened = value<{ id: string; size: number; sha256: string }>(await c.call('blob.open', ['draft-file', 'ref_fixture']));
        expect(opened.size).toBe(0); expect(opened.sha256).toBe(hash(new Uint8Array()));
        expect(value(await c.call('blob.read', [opened.id, 0, 0]))).toEqual({ base64: '' });
        expect(await c.call('blob.read', [opened.id, 0, 1])).toMatchObject({ ok: false });
    });
    it.each([
        ['other-kind', 'ref_fixture'], ['workspace-file', null], ['workspace-file', '../outside'],
        ['workspace-file', 'C:\\outside'], ['workspace-file', 'x'.repeat(1024)],
    ])('refuses invalid kind/reference %j before opening content', async (kind, ref) => {
        const f = await fixture(10), c = await f.raw();
        expect(await c.call('blob.open', [kind, ref])).toMatchObject({ ok: false, reason: expect.any(String) });
        expect(f.openBlob).not.toHaveBeenCalled();
    });
    it.each([
        [-1, 1], [0, CHUNK + 1], [0.5, 1], [0, 1.5], [0, -1], [null, 1], [0, null],
        [Number.MAX_SAFE_INTEGER, 1], [20, 1], [10, 11],
    ])('refuses out-of-range/noninteger read offset=%j length=%j before a source read', async (offset, length) => {
        const f = await fixture(20), c = await f.raw(), opened = value<{ id: string }>(await c.call('blob.open', ['draft-file', 'ref_fixture']));
        expect(await c.call('blob.read', [opened.id, offset, length])).toMatchObject({ ok: false, reason: expect.any(String) });
        expect(f.sources[0]!.read).not.toHaveBeenCalled();
    });
    it('refuses a short or excessive source read instead of returning different bytes as success', async () => {
        const f = await fixture(20), c = await f.raw(), opened = value<{ id: string }>(await c.call('blob.open', ['draft-file', 'ref_fixture']));
        f.sources[0]!.read.mockResolvedValueOnce(new Uint8Array(3)).mockResolvedValueOnce(new Uint8Array(5));
        expect(await c.call('blob.read', [opened.id, 0, 4])).toMatchObject({ ok: false });
        expect(await c.call('blob.read', [opened.id, 0, 4])).toMatchObject({ ok: false });
    });
    it('one connection cannot read or close another connection’s blob', async () => {
        const f = await fixture(20), a = await f.raw(), b = await f.raw();
        const one = value<{ id: string }>(await a.call('blob.open', ['draft-file', 'ref_fixture']));
        const two = value<{ id: string }>(await b.call('blob.open', ['draft-file', 'ref_fixture']));
        expect(one.id).not.toBe(two.id);
        expect(await b.call('blob.read', [one.id, 0, 1])).toMatchObject({ ok: false });
        expect(value(await b.call('blob.close', [one.id]))).toEqual({ closed: false });
        expect(value(await a.call('blob.read', [one.id, 0, 1]))).toEqual({ base64: Buffer.from(f.bytes.slice(0, 1)).toString('base64') });
        expect(f.sources[0]!.close).not.toHaveBeenCalled();
    });
    it('limits each connection to eight live opens and releases a slot on close', async () => {
        const f = await fixture(20), c = await f.raw(), ids: string[] = [];
        for (let i = 0; i < 8; i++) ids.push(value<{ id: string }>(await c.call('blob.open', ['draft-file', 'ref_fixture'])).id);
        expect(await c.call('blob.open', ['draft-file', 'ref_fixture'])).toMatchObject({ ok: false, reason: expect.stringContaining('8') });
        expect(f.openBlob).toHaveBeenCalledTimes(8);
        expect(value(await c.call('blob.close', [ids[0]]))).toEqual({ closed: true });
        expect(value(await c.call('blob.close', [ids[0]]))).toEqual({ closed: false });
        expect(await c.call('blob.read', [ids[0], 0, 1])).toMatchObject({ ok: false });
        expect(value(await c.call('blob.open', ['draft-file', 'ref_fixture']))).toHaveProperty('id');
    });
    it('a failed backend open releases its reserved slot', async () => {
        const f = await fixture(20), c = await f.raw(); f.openBlob.mockRejectedValueOnce(new Error('content is gone'));
        expect(await c.call('blob.open', ['draft-file', 'ref_fixture'])).toMatchObject({ ok: false, reason: 'content is gone' });
        for (let i = 0; i < 8; i++) expect(value(await c.call('blob.open', ['draft-file', 'ref_fixture']))).toHaveProperty('id');
    });
    it('disconnect closes exactly its own sources while another window keeps reading', async () => {
        const f = await fixture(20), a = await f.raw(), b = await f.raw();
        await a.call('blob.open', ['draft-file', 'ref_fixture']);
        const other = value<{ id: string }>(await b.call('blob.open', ['draft-file', 'ref_fixture']));
        a.transport.close(); await tick();
        expect(f.sources[0]!.close).toHaveBeenCalledOnce(); expect(f.sources[1]!.close).not.toHaveBeenCalled();
        expect(value(await b.call('blob.read', [other.id, 0, 1]))).toHaveProperty('base64');
    });
    it('pending opens count toward the quota and are closed if the connection dies before they answer', async () => {
        const f = await fixture(20), c = await f.raw(), realOpen = f.openBlob.getMockImplementation()!;
        let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
        f.openBlob.mockImplementation(async (kind, ref) => { await gate; return realOpen(kind, ref); });
        try {
            for (let i = 0; i < 8; i++) c.send('blob.open', ['draft-file', 'ref_fixture']);
            await tick(); expect(f.openBlob).toHaveBeenCalledTimes(8);
            expect(await c.call('blob.open', ['draft-file', 'ref_fixture'])).toMatchObject({ ok: false, reason: expect.stringContaining('8') });
            c.transport.close(); release(); await tick();
            expect(f.sources).toHaveLength(8); for (const source of f.sources) expect(source.close).toHaveBeenCalledOnce();
        } finally { release(); }
    });
    it.each(['tailnet owner', 'relay owner', 'workspace guest', 'host guest', 'readonly relay', 'phone owner', 'phone relay guest'])('%s cannot operate blob controls', async name => {
        const f = await fixture(20), guest = name.includes('guest'), relay = name.includes('relay') || guest;
        const c = await f.raw(relay ? { label: name, isOwner: !guest, workspaceId: name === 'workspace guest' ? 'work' : null, readonly: name.includes('readonly') } : 'tailnet', name.startsWith('phone'));
        for (const [method, args] of [['blob.open', ['draft-file', 'ref_fixture']], ['blob.read', ['foreign', 0, 1]], ['blob.close', ['foreign']]] as const)
            expect(await c.call(method, [...args])).toMatchObject({ ok: false, reason: expect.stringContaining('own Genie window') });
        expect(f.openBlob).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
    });
});

describe('the verified reader uses the local client’s existing frame stream', () => {
    it('reassembles more than one frame, verifies SHA-256, closes, and leaves the connection usable', async () => {
        const f = await fixture(), c = await f.client(), port = blobs(c);
        expect(await port.readAll('artboard-post', 'ref_fixture')).toEqual(f.bytes);
        expect(f.calls.map(call => call.method)).toEqual(['blob.open', ...Array(5).fill('blob.read'), 'blob.close']);
        expect(f.sources[0]!.close).toHaveBeenCalledOnce(); expect(c.state().connected).toBe(true);
        await c.bridge.workspaces.settings('work'); expect(f.invoke).toHaveBeenCalledWith('workspaces.settings', ['work']);
        expect(Math.max(...f.serialized.map(text => Buffer.byteLength(text, 'utf8')))).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
    });
    it('rejects changed content on hash mismatch and still closes its handle', async () => {
        const f = await fixture(20), realOpen = f.openBlob.getMockImplementation()!;
        f.openBlob.mockImplementation(async (kind, ref) => { const source = await realOpen(kind, ref); source.sha256 = '0'.repeat(64); return source; });
        const c = await f.client(); await expect(blobs(c).readAll('draft-file', 'ref_fixture')).rejects.toThrow(/hash|SHA-256/i);
        expect(f.sources[0]!.close).toHaveBeenCalledOnce(); expect(c.state().connected).toBe(true);
    });
    it('a read refusal is a visible rejection and the reader closes the opened handle', async () => {
        const f = await fixture(20), realOpen = f.openBlob.getMockImplementation()!;
        f.openBlob.mockImplementation(async (kind, ref) => { const source = await realOpen(kind, ref); source.read = vi.fn(async () => { throw new Error('source became unreadable'); }); return source; });
        const c = await f.client(); await expect(blobs(c).readAll('draft-file', 'ref_fixture')).rejects.toThrow('source became unreadable');
        expect(f.sources[0]!.close).toHaveBeenCalledOnce();
    });
    it('rejects malformed base64 instead of accepting a permissive decode', async () => {
        const f = await fixture(20);
        f.wire.rewrite = text => {
            const frame = JSON.parse(text);
            if (frame.kind === 'result' && frame.ok && typeof frame.value?.base64 === 'string') frame.value.base64 = '$not-base64';
            return JSON.stringify(frame);
        };
        const c = await f.client(); await expect(blobs(c).readAll('draft-file', 'ref_fixture')).rejects.toThrow(/base64/i);
        expect(f.sources[0]!.close).toHaveBeenCalledOnce();
    });
    it('disconnect during a pending read rejects the caller and releases the source exactly once', async () => {
        const f = await fixture(20), realOpen = f.openBlob.getMockImplementation()!;
        let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
        f.openBlob.mockImplementation(async (kind, ref) => { const source = await realOpen(kind, ref); source.read = vi.fn(async () => { await gate; return f.bytes.slice(); }); return source; });
        try {
            const c = await f.client(), pending = blobs(c).readAll('draft-file', 'ref_fixture');
            const rejected = expect(pending).rejects.toThrow(/closed/i);
            await tick(); expect(f.sources[0]!.read).toHaveBeenCalledOnce(); c.close(); await rejected;
            release(); await tick(); expect(f.sources[0]!.close).toHaveBeenCalledOnce();
        } finally { release(); }
    });
    it('empty content is verified and closed without issuing a data read', async () => {
        const f = await fixture(0), c = await f.client(); expect(await blobs(c).readAll('draft-file', 'ref_fixture')).toEqual(new Uint8Array());
        expect(f.calls.map(call => call.method)).toEqual(['blob.open', 'blob.close']); expect(f.sources[0]!.close).toHaveBeenCalledOnce();
    });
    it('a remote client has no blob facade', async () => {
        const f = await fixture(20), c = await f.client({ label: 'remote', isOwner: true, workspaceId: null, readonly: false });
        expect((c as unknown as { blobs?: unknown }).blobs).toBeUndefined();
    });
});
