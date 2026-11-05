import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMessage, type PreAuth } from '../src/core/remote-protocol.js';
import { UploadStaging, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../src/core/mobile-wire.js';
import { resourceDoor, resultValue } from './support/local-resource-door.js';

const MiB = 1024 * 1024, LIMIT = 100 * MiB, CHUNK = 256 * 1024, PAGE_BYTES = 512 * 1024;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
type Input = { purpose: string; subtype: string; size: number; maxBytes?: number };
interface StageSource { size: number; sha256: string; read(offset: number, length: number): Promise<Uint8Array>; close(): Promise<void> }
interface Staging {
    begin(input: Input): Promise<{ id: string; size: number }>;
    chunk(id: string, index: unknown, base64: unknown): Promise<{ received: number }>;
    abort(id: string): Promise<{ aborted: boolean }>;
    take(id: string, purpose: string, subtype: string): Promise<StageSource | null>;
    dispose(): Promise<void>;
}
async function staging(clock = { now: 0 }) {
    const root = await mkdtemp(join(tmpdir(), 'genie-p4-stage-'));
    // Dynamic until the new module exists: the initial hosted red is missing behaviour, not a tsc failure.
    const path: string = '../src/main/local-uploads.js', module = await import(path);
    const s = new module.LocalUploads({ root, now: () => clock.now }) as Staging;
    cleanups.push(async () => { await s.dispose(); await rm(root, { recursive: true, force: true }); });
    return { s, root, clock };
}
const rows = [
    ['draft-file', 'attachment'], ['draft-file', 'text'], ['file-write', 'text'], ['file-write', 'bytes'], ['board-image', 'comment'],
] as const;
const input = (size: number, purpose = 'draft-file', subtype = 'attachment'): Input => ({ purpose, subtype, size });
function exact(actual: Uint8Array, expected: Uint8Array) {
    expect(actual).toBeInstanceOf(Uint8Array); expect(actual.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

describe('7B local disk staging, not used by any family', () => {
    it.each(rows)('%s/%s uses the host table, accepts zero and 100MiB, refuses one more', async (purpose, subtype) => {
        const { s } = await staging();
        const zero = await s.begin(input(0, purpose, subtype)), empty = await s.take(zero.id, purpose, subtype);
        expect(empty?.size).toBe(0); expect(empty?.sha256).toBe(createHash('sha256').digest('hex')); await empty!.close();
        const boundary = await s.begin(input(LIMIT, purpose, subtype)); expect(boundary.size).toBe(LIMIT); await s.abort(boundary.id);
        await expect(s.begin({ ...input(LIMIT + 1, purpose, subtype), maxBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/limit|104857600|100/i);
    });
    it.each([
        input(-1), input(0.5), input(NaN), input(Infinity), input(Number.MAX_SAFE_INTEGER),
        input(1, 'other'), input(1, 'draft-file', 'bytes'), input(1, 'board-image', 'image'),
    ])('refuses malformed size or undeclared purpose/subtype %j', async bad => {
        const { s } = await staging(); await expect(s.begin(bad)).rejects.toThrow();
    });
    it('writes exact ordered chunks to disk, exposes only the matching host consumer, and takes once', async () => {
        const { s, root } = await staging(), bytes = Uint8Array.from({ length: 2 * MiB + 13 }, (_, i) => i % 251);
        const b = await s.begin(input(bytes.length));
        await expect(s.chunk(b.id, 1, base64(bytes.subarray(0, 1)))).rejects.toThrow(/chunk|order/i);
        for (let at = 0, index = 0; at < bytes.length; at += CHUNK, index++) await s.chunk(b.id, index, base64(bytes.subarray(at, at + CHUNK)));
        expect((await readdir(root)).length).toBeGreaterThan(0);
        expect(await s.take(b.id, 'file-write', 'bytes')).toBeNull();
        expect(await s.take(b.id, 'draft-file', 'text')).toBeNull();
        const source = await s.take(b.id, 'draft-file', 'attachment'); expect(source?.size).toBe(bytes.length);
        expect(source?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(await s.take(b.id, 'draft-file', 'attachment')).toBeNull();
        const parts: Uint8Array[] = [];
        for (let at = 0; at < bytes.length; at += PAGE_BYTES) parts.push(await source!.read(at, Math.min(PAGE_BYTES, bytes.length - at)));
        exact(new Uint8Array(Buffer.concat(parts)), bytes); await source!.close();
        await expect(source!.read(0, 1)).rejects.toThrow();
        await s.dispose(); expect(await readdir(root)).toEqual([]);
    });
    it('streams a complete 100MiB attachment with the original limit and a full content hash', async () => {
        const { s } = await staging(), b = await s.begin(input(LIMIT)), chunk = Buffer.alloc(CHUNK, 117), expected = createHash('sha256');
        for (let n = 0; n < LIMIT / CHUNK; n++) { expected.update(chunk); await s.chunk(b.id, n, chunk.toString('base64')); }
        const source = await s.take(b.id, 'draft-file', 'attachment'); expect(source?.size).toBe(LIMIT);
        expect(source?.sha256).toBe(expected.digest('hex'));
        exact(await source!.read(LIMIT - CHUNK, CHUNK), chunk); await source!.close();
    });
    it('refuses empty, oversized, malformed and over-declared chunks without moving the index', async () => {
        const { s } = await staging(), b = await s.begin(input(CHUNK));
        for (const bad of ['', '%%%', 5, base64(new Uint8Array(CHUNK + 1))]) await expect(s.chunk(b.id, 0, bad)).rejects.toThrow();
        expect(await s.chunk(b.id, 0, base64(new Uint8Array(CHUNK)))).toEqual({ received: CHUNK });
        await expect(s.chunk(b.id, 1, 'YQ==')).rejects.toThrow();
        expect((await s.take(b.id, 'draft-file', 'attachment'))?.size).toBe(CHUNK);
    });
    it('owns handles, refuses incomplete/foreign stages, and aborts once', async () => {
        const { s } = await staging(), other = (await staging()).s, b = await s.begin(input(2));
        expect(await s.take(b.id, 'draft-file', 'attachment')).toBeNull();
        await expect(other.chunk(b.id, 0, 'YWI=')).rejects.toThrow();
        expect(await other.abort(b.id)).toEqual({ aborted: false });
        expect(await other.take(b.id, 'draft-file', 'attachment')).toBeNull();
        expect(await s.abort(b.id)).toEqual({ aborted: true }); expect(await s.abort(b.id)).toEqual({ aborted: false });
        await expect(s.chunk(b.id, 0, 'YWI=')).rejects.toThrow();
    });
    it('reserves only three open uploads, including concurrent begins; expiry releases them', async () => {
        const { s, clock } = await staging();
        const opened = await Promise.allSettled(Array.from({ length: 4 }, () => s.begin(input(1))));
        expect(opened.filter(r => r.status === 'fulfilled')).toHaveLength(3); expect(opened.filter(r => r.status === 'rejected')).toHaveLength(1);
        clock.now = 11 * 60_000;
        for (const r of opened) if (r.status === 'fulfilled') await expect(s.chunk(r.value.id, 0, 'YQ==')).rejects.toThrow();
        expect((await s.begin(input(1))).id).toEqual(expect.any(String));
    });
    it('serializes duplicate concurrent chunks and releases a claimed source on disconnect', async () => {
        const { s, root } = await staging(), b = await s.begin(input(1));
        const chunks = await Promise.allSettled([s.chunk(b.id, 0, 'YQ=='), s.chunk(b.id, 0, 'YQ==')]);
        expect(chunks.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        const taken = await s.take(b.id, 'draft-file', 'attachment'); expect(taken).not.toBeNull();
        await s.dispose(); await s.dispose(); expect(await readdir(root)).toEqual([]);
        await expect(taken!.read(0, 1)).rejects.toThrow(); await expect(s.begin(input(1))).rejects.toThrow(/closed/i);
    });
    it('disconnect during a pending begin leaves neither a returned live handle nor disk files', async () => {
        const { s, root } = await staging(); const opening = s.begin(input(1)); const stopped = s.dispose();
        await expect(opening).rejects.toThrow(/closed/i); await stopped; expect(await readdir(root)).toEqual([]);
    });
});

interface Item { id: string; name: string; ref?: string }
interface Page { items: Item[]; cursor: string | null }
interface PageSource { next(): Promise<Item | null>; close(): Promise<void> }
function pageSource(items: Item[]) {
    let index = 0;
    return { next: vi.fn(async () => items[index++] ?? null), close: vi.fn(async () => {}) } satisfies PageSource;
}
const kinds = ['folder-children', 'workspace-tree', 'chat-drafts', 'artboard-posts', 'artboard-comments'] as const;

describe('7B bounded metadata pages over the admitted local door', () => {
    it.each(['localUpload.begin', 'localUpload.chunk', 'localUpload.abort', 'page.open', 'page.next', 'page.close'])('%s is a recognized connection control', method => {
        expect(parseMessage(JSON.stringify({ kind: 'call', id: 1, method, args: [] }))).toMatchObject({ ok: true, message: { method } });
    });
    it.each(kinds)('%s resolves a host ref and sends complete metadata under both page budgets', async kind => {
        const items = Array.from({ length: 301 }, (_, i) => ({ id: `id_${i}`, name: '😀'.repeat(i % 2 ? 3000 : 3), ref: `ref_${i}` }));
        const source = pageSource(items), openPage = vi.fn(async () => source), f = await resourceDoor(cleanups, { openPage }), c = await f.raw();
        let page = resultValue<Page>(await c.call('page.open', [kind, 'ref_fixture'])), collected: Item[] = [];
        expect(openPage).toHaveBeenCalledExactlyOnceWith(kind, 'ref_fixture');
        do {
            expect(page.items.length).toBeGreaterThan(0); expect(page.items.length).toBeLessThanOrEqual(128);
            expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PAGE_BYTES);
            collected.push(...page.items); if (page.cursor === null) break;
            page = resultValue<Page>(await c.call('page.next', [page.cursor]));
        } while (true);
        expect(collected).toEqual(items); expect(source.close).toHaveBeenCalledOnce(); expect(f.invoke).not.toHaveBeenCalled();
        expect(Math.max(...f.serialized.map(s => Buffer.byteLength(s)))).toBeLessThan(1024 * 1024);
    });
    it('empty lists finish, release their source, and leave the same connection usable', async () => {
        const source = pageSource([]), f = await resourceDoor(cleanups, { openPage: async () => source }), c = await f.raw();
        expect(resultValue(await c.call('page.open', ['chat-drafts', 'ref_empty']))).toEqual({ items: [], cursor: null });
        expect(source.close).toHaveBeenCalledOnce(); expect(await c.call('baton.status', [])).toMatchObject({ ok: true });
    });
    it('oversized record reports its id/UTF8 size visibly without advancing its cursor', async () => {
        const big = { id: 'id_oversize', name: '😀'.repeat(PAGE_BYTES / 4) }, small = Array.from({ length: 128 }, (_, i) => ({ id: `id_${i}`, name: 'small' }));
        const source = pageSource([...small, big, { id: 'id_last', name: 'last' }]), f = await resourceDoor(cleanups, { openPage: async () => source }), c = await f.raw();
        const p = resultValue<Page>(await c.call('page.open', ['folder-children', 'ref_big'])); expect(p.items).toHaveLength(128); expect(p.cursor).toEqual(expect.any(String));
        const first = await c.call('page.next', [p.cursor]), count = source.next.mock.calls.length;
        expect(first).toMatchObject({ ok: false, reason: expect.stringContaining('id_oversize') });
        expect((first as { reason: string }).reason).toContain(String(Buffer.byteLength(JSON.stringify(big))));
        expect(await c.call('page.next', [p.cursor])).toEqual({ ...first, id: expect.any(Number) }); expect(source.next).toHaveBeenCalledTimes(count);
        expect(await c.call('baton.status', [])).toMatchObject({ ok: true });
        expect(resultValue(await c.call('page.close', [p.cursor]))).toEqual({ closed: true }); expect(source.close).toHaveBeenCalledOnce();
    });
    it('another connection cannot advance or close a cursor; close/disconnect release it', async () => {
        const sources: ReturnType<typeof pageSource>[] = [], f = await resourceDoor(cleanups, { openPage: async () => { const s = pageSource(Array.from({ length: 300 }, (_, i) => ({ id: `id_${i}`, name: 'x' }))); sources.push(s); return s; } });
        const a = await f.raw(), b = await f.raw(), p = resultValue<Page>(await a.call('page.open', ['workspace-tree', 'ref_tree']));
        expect(await b.call('page.next', [p.cursor])).toMatchObject({ ok: false });
        expect(resultValue(await b.call('page.close', [p.cursor]))).toEqual({ closed: false }); expect(sources[0]!.close).not.toHaveBeenCalled();
        a.transport.close(); await new Promise<void>(r => setImmediate(r)); expect(sources[0]!.close).toHaveBeenCalledOnce();
    });
    it.each([['other', 'ref_x'], ['chat-drafts', '../outside'], ['chat-drafts', 'C:\\outside'], ['chat-drafts', 'x'.repeat(129)]])('refuses invalid list kind/ref %j without a source call', async (kind, ref) => {
        const openPage = vi.fn(async () => pageSource([])), f = await resourceDoor(cleanups, { openPage }), c = await f.raw();
        expect(await c.call('page.open', [kind, ref])).toMatchObject({ ok: false }); expect(openPage).not.toHaveBeenCalled();
    });
    it('counts pending page opens toward the eight-source quota and closes late sources', async () => {
        let resolve!: (source: PageSource) => void;
        const pending = new Promise<PageSource>(r => { resolve = r; });
        const openPage = vi.fn(async () => pending), f = await resourceDoor(cleanups, { openPage }), c = await f.raw();
        const calls = Array.from({ length: 8 }, () => c.call('page.open', ['chat-drafts', 'ref_pending']));
        expect(await c.call('page.open', ['chat-drafts', 'ref_pending'])).toMatchObject({ ok: false, reason: expect.stringContaining('8') });
        c.transport.close(); const source = pageSource([]); resolve(source); await new Promise<void>(r => setImmediate(r));
        expect(source.close).toHaveBeenCalledTimes(8); void calls;
    });
    const nonlocals: Array<[string, PreAuth | 'tailnet', boolean]> = [
        ['owner', 'tailnet', false], ['relay', { label: 'owner', isOwner: true, workspaceId: null, readonly: false }, false],
        ['guest', { label: 'guest', isOwner: false, workspaceId: 'ws', readonly: false }, false],
        ['readonly', { label: 'read', isOwner: false, workspaceId: 'ws', readonly: true }, false], ['phone', 'tailnet', true],
    ];
    it.each(nonlocals)('%s cannot call any local staging/page control before source or business code', async (_label, proof, mobile) => {
        const openPage = vi.fn(async () => pageSource([])), f = await resourceDoor(cleanups, { openPage }), c = await f.raw(proof, mobile);
        for (const method of ['localUpload.begin', 'localUpload.chunk', 'localUpload.abort', 'page.open', 'page.next', 'page.close'])
            expect(await c.call(method, [input(0)])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining("resource-fixture's own Genie window") });
        expect(openPage).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
    });
    it('local uploads have a positive wire control, retain zero-byte support and are isolated from phone stages', async () => {
        const f = await resourceDoor(cleanups), c = await f.raw();
        const b = resultValue<{ id: string; size: number }>(await c.call('localUpload.begin', [input(0)])); expect(b.size).toBe(0);
        expect(resultValue(await c.call('upload.abort', [b.id]))).toEqual({ aborted: false });
        expect(resultValue(await c.call('localUpload.abort', [b.id]))).toEqual({ aborted: true });
        expect(await c.call('baton.status', [])).toMatchObject({ ok: true });
    });
    it('wire chunks belong to their connection, and disconnect disposes the server staging area', async () => {
        const { s, root } = await staging(), other = (await staging()).s, disposed = vi.spyOn(s, 'dispose');
        const stages = [s, other];
        const f = await resourceDoor(cleanups, { createLocalUploads: () => stages.shift()! }), a = await f.raw(), b = await f.raw();
        const opened = resultValue<{ id: string }>(await a.call('localUpload.begin', [input(1)]));
        expect(await b.call('localUpload.chunk', [opened.id, 0, 'YQ=='])).toMatchObject({ ok: false });
        expect(resultValue(await b.call('localUpload.abort', [opened.id]))).toEqual({ aborted: false });
        expect(resultValue(await a.call('localUpload.chunk', [opened.id, 0, 'YQ==']))).toEqual({ received: 1 });
        a.transport.close(); await new Promise<void>(r => setImmediate(r)); expect(disposed).toHaveBeenCalledOnce();
        await disposed.mock.results[0]!.value; expect(await readdir(root)).toEqual([]);
    });
    it('the renderer aborts an upload after a refused chunk and closes a page cursor when cancelled', async () => {
        const source = pageSource(Array.from({ length: 300 }, (_, i) => ({ id: `id_${i}`, name: 'x' })));
        const f = await resourceDoor(cleanups, { openPage: async () => source }), client = await f.client();
        const local = client as unknown as {
            uploads?: { stage(input: Omit<Input, 'size'>, bytes: Uint8Array): Promise<unknown> };
            pages?: { readAll(kind: string, ref: string, options?: { signal: AbortSignal }): Promise<Item[]> };
        };
        expect(local.uploads).toBeDefined(); expect(local.pages).toBeDefined();
        f.rewrite.frame = text => {
            const r = JSON.parse(text);
            if (r.kind === 'result' && r.ok && r.value?.received !== undefined) return JSON.stringify({ kind: 'result', id: r.id, ok: false, reason: 'fixture chunk refusal' });
            return text;
        };
        await expect(local.uploads!.stage({ purpose: 'draft-file', subtype: 'attachment' }, new Uint8Array(1))).rejects.toThrow('fixture chunk refusal');
        expect(f.calls.filter(c => c.method === 'localUpload.abort')).toHaveLength(1);
        const controller = new AbortController();
        f.rewrite.frame = text => { const r = JSON.parse(text); if (r.kind === 'result' && r.ok && r.value?.cursor) controller.abort(); return text; };
        await expect(local.pages!.readAll('chat-drafts', 'ref_cancel', { signal: controller.signal })).rejects.toThrow(/abort|cancel/i);
        expect(f.calls.filter(c => c.method === 'page.close')).toHaveLength(1); expect(source.close).toHaveBeenCalledOnce();
    });
    it('the same local client stages bytes and assembles pages; remote clients have neither facade', async () => {
        const items = Array.from({ length: 300 }, (_, i) => ({ id: `id_${i}`, name: 'entry' }));
        const f = await resourceDoor(cleanups, { openPage: async () => pageSource(items) }), client = await f.client();
        const local = client as unknown as { uploads?: { stage(input: Omit<Input, 'size'>, bytes: Uint8Array): Promise<{ id: string; size: number }>; abort(id: string): Promise<{ aborted: boolean }> }; pages?: { readAll(kind: string, ref: string): Promise<Item[]> } };
        expect(local.uploads).toBeDefined(); expect(local.pages).toBeDefined();
        const bytes = new Uint8Array(CHUNK + 7), b = await local.uploads!.stage({ purpose: 'draft-file', subtype: 'attachment' }, bytes);
        expect(b.size).toBe(bytes.length); expect(await local.uploads!.abort(b.id)).toEqual({ aborted: true });
        expect(await local.pages!.readAll('chat-drafts', 'ref_all')).toEqual(items);
        expect(f.calls.filter(c => c.method === 'localUpload.chunk').map(c => c.args[1])).toEqual([0, 1]);
        const remote = await f.client({ label: 'owner', isOwner: true, workspaceId: null, readonly: false });
        expect((remote as unknown as { uploads?: unknown }).uploads).toBeUndefined(); expect((remote as unknown as { pages?: unknown }).pages).toBeUndefined();
    });
});

it('CONTROL: the existing phone staging still uses 25MiB, names, positive sizes, 256KiB chunks and three opens', () => {
    expect(UPLOAD_CHUNK_BYTES).toBe(CHUNK); expect(UPLOAD_MAX_BYTES).toBe(25 * MiB);
    const s = new UploadStaging({ now: () => 0 });
    for (const bad of [{ name: '', size: 1 }, { name: 'setup.exe', size: 1 }, { name: 'a.txt', size: 0 }, { name: 'a.txt', size: UPLOAD_MAX_BYTES + 1 }]) expect(s.begin('phone', bad)).toMatchObject({ ok: false });
    const b = s.begin('phone', { name: 'a.txt', size: 2 }); if (!b.ok) throw new Error(b.reason);
    expect(s.chunk('other', b.id, 0, 'YWI=')).toMatchObject({ ok: false }); expect(s.chunk('phone', b.id, 1, 'YWI=')).toMatchObject({ ok: false });
    expect(s.chunk('phone', b.id, 0, 'YWI=')).toEqual({ ok: true, received: 2 }); expect(s.take('phone', b.id)?.name).toBe('a.txt'); expect(s.take('phone', b.id)).toBeNull();
    for (let i = 0; i < 3; i++) expect(s.begin('phone', { name: 'a.txt', size: 1 }).ok).toBe(true);
    expect(s.begin('phone', { name: 'a.txt', size: 1 }).ok).toBe(false);
});
