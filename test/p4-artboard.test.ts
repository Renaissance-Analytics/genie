import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardPost } from '../src/core/artboard.js';
import { LOCAL_UPLOAD_TTL_MS } from '../src/core/local-content.js';
import { capabilityOf, REMOTE_METHODS, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { artboardRead, artboardReadFiles, artboardReview } from '../src/main/official-panels-host.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { resourceDoor, resultValue } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const methods = ['artboard.read', 'artboard.review'] as const;
const post = (value: Partial<BoardPost> = {}): BoardPost => ({ id: 'p1', title: 'A mockup', kind: 'html', file: 'p1.html', createdAt: '2026-11-05T01:00:00Z', agentId: 'agent_a', askVerdict: true, ...value });
interface Ref { ref: string; size: number; sha256: string; type: string }
interface Metadata { id: string; postId: string; title: string; kind: string; artifact: Ref; review?: { verdict: string; at: string; comment?: Ref } }
interface Envelope { artboardContent: { ref: string; list: string; count: number; error?: string } }
type Raw = { call(method: string, args: unknown[]): Promise<WireMessage> };
async function staged(raw: Raw, text: string, purpose = 'board-image', subtype = 'comment'): Promise<string> {
    const bytes = Buffer.from(text), opened = resultValue<{ id: string }>(await raw.call('localUpload.begin', [{ purpose, subtype, size: bytes.length }]));
    for (let at = 0, index = 0; at < bytes.length; at += 256 * 1024, index++) resultValue(await raw.call('localUpload.chunk', [opened.id, index, bytes.subarray(at, at + 256 * 1024).toString('base64')]));
    return opened.id;
}
async function fixture(options: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'genie-p4-artboard-')), board = join(root, '.artboard'); await mkdir(board);
    const sent: Array<{ agentId: string; text: string }> = [];
    const deps = { workspacePath: (id: string) => id === 'work' ? root : null, now: () => '2026-11-05T02:00:00Z', send: async (agentId: string, text: string) => { sent.push({ agentId, text }); } };
    const ports = { read: vi.fn((id: unknown) => artboardReadFiles(deps, id)), review: vi.fn((...args: unknown[]) => artboardReview(deps, args[0], args[1], args[2], args[3])) };
    try {
        const f = await resourceDoor(cleanups, options, { artboard: ports });
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        const index = (posts: BoardPost[]) => writeFile(join(board, 'index.json'), JSON.stringify({ posts }));
        await writeFile(join(board, 'p1.html'), '<h1>Kept mockup 雪</h1>'); await index([post()]);
        const c = await f.client();
        const bridge = () => { expect(c.bridge.artboard).toBeDefined(); return c.bridge.artboard!; };
        return { ...f, c, bridge, root, board, index, ports, deps, sent, native: () => artboardRead(deps, 'work') };
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
async function body(f: Awaited<ReturnType<typeof fixture>>, raw: Raw) {
    const envelope = resultValue<Envelope>(await raw.call('artboard.read', ['work']));
    expect(envelope.artboardContent).toMatchObject({ ref: expect.any(String), list: expect.any(String), count: expect.any(Number) });
    return envelope.artboardContent;
}

describe('7F ArtBoard on the admitted local connection', () => {
    it.each(methods)('%s is explicitly local', method => {
        expect(REMOTE_METHODS).toContain(method); expect(capabilityOf(method as RemoteMethod)).toBe('local');
    });
    it('read preserves native fields for present posts and keeps each missing artifact visible', async () => {
        const f = await fixture(), legacy = post({ note: 'Review this' }); delete legacy.askVerdict;
        await f.index([post({ id: 'missing', file: 'gone.html' }), legacy, post({ id: 'bad-image', kind: 'image', file: 'raw.bin' })]);
        const native = await f.native(); expect(native.posts).toHaveLength(1); expect(native.error).toContain('2 posts');
        const shown = await f.bridge().read('work');
        expect(shown.posts).toHaveLength(3); expect(shown.posts.find(p => p.id === legacy.id)).toEqual(native.posts[0]);
        expect(shown.posts.find(p => p.id === 'missing')).toMatchObject({ contentError: expect.stringMatching(/missing|not found|ENOENT/i) });
        expect(shown.posts.find(p => p.id === 'bad-image')).toMatchObject({ contentError: expect.stringMatching(/image|type|unsupported/i) });
        expect(f.ports.read).toHaveBeenLastCalledWith('work');
    });
    it('an empty or unknown workspace keeps native results, and a missing host refuses in words', async () => {
        const f = await fixture(); await f.index([]);
        expect(await f.bridge().read('work')).toEqual({ posts: [] }); expect(await f.bridge().read('gone')).toEqual(await artboardRead(f.deps, 'gone'));
        const absent = await resourceDoor(cleanups), c = await absent.client(); expect(c.bridge.artboard).toBeDefined(); await expect(c.bridge.artboard!.read('work')).rejects.toThrow(/ArtBoard|artboard|available|configured/i);
    });
    it.each(['tailnet', 'relay owner', 'workspace guest', 'host guest', 'readonly', 'phone'])('%s cannot reach either ArtBoard port', async kind => {
        const f = await fixture(), raw = kind === 'tailnet' || kind === 'phone' ? await f.raw('tailnet', kind === 'phone') : await f.raw({ kind: 'relay', label: kind, isOwner: kind === 'relay owner', workspaceId: kind === 'workspace guest' ? 'work' : null, readonly: kind === 'readonly' });
        f.invoke.mockClear();
        for (const method of methods) expect(await raw.call(method, ['work', 'p1', 'approved', 'hello'])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('own Genie window') });
        expect(f.invoke).not.toHaveBeenCalled();
    });
    it('lists metadata only; even small HTML and review text use artboard-post blobs', async () => {
        const f = await fixture(), html = '<h1>Small but still content</h1>', comment = 'kept review text'; await writeFile(join(f.board, 'p1.html'), html);
        await f.index([post({ review: { verdict: 'approved', at: '2026-11-05T01:30:00Z', comment } })]);
        const raw = await f.raw(), value = await body(f, raw), c = f.c;
        const rows = resultValue<{ items: Metadata[] }>(await raw.call('page.open', ['artboard-posts', value.list]));
        expect(rows.items).toHaveLength(1); const row = rows.items[0]!;
        expect(row).not.toHaveProperty('html'); expect(row).not.toHaveProperty('src'); expect(JSON.stringify(rows)).not.toContain(html); expect(JSON.stringify(rows)).not.toContain(comment);
        expect(row.artifact).toMatchObject({ ref: expect.any(String), size: Buffer.byteLength(html), sha256: sha(html), type: 'text/html' });
        const blob = resultValue<{ id: string; size: number; sha256: string }>(await raw.call('blob.open', ['artboard-post', row.artifact.ref]));
        expect(blob.size).toBe(Buffer.byteLength(html)); expect(blob.sha256).toBe(sha(html));
        expect(resultValue<{ base64: string }>(await raw.call('blob.read', [blob.id, 0, blob.size])).base64).toBe(Buffer.from(html).toString('base64'));
        resultValue(await raw.call('blob.close', [blob.id])); resultValue(await raw.call('content.release', [value.ref]));
        expect(c.bridge.artboard).toBeDefined(); expect(await c.bridge.artboard!.read('work')).toEqual(await f.native());
    });
    it('100 native posts page by serialized size without content or omitted entries', async () => {
        const f = await fixture(), posts = Array.from({ length: 100 }, (_, i) => post({ id: 'p' + i, title: String(i) + '雪'.repeat(4500), file: 'p1.html', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
        await f.index(posts); const raw = await f.raw(), value = await body(f, raw); expect(value.count).toBe(100);
        let page = resultValue<{ items: Metadata[]; cursor: string | null }>(await raw.call('page.open', ['artboard-posts', value.list])), pages = 1; const rows = [...page.items];
        while (page.cursor) { page = resultValue(await raw.call('page.next', [page.cursor])); pages++; rows.push(...page.items); }
        expect(pages).toBeGreaterThan(1); expect(rows.map(p => p.id)).toEqual(rows.map((_, index) => String(index))); expect(rows.map(p => p.postId)).toEqual([...posts].reverse().map(p => p.id)); expect(rows.every(p => !('html' in p) && !('src' in p))).toBe(true);
        for (const text of f.serialized) { const frame = JSON.parse(text); if (frame.kind === 'result' && Array.isArray(frame.value?.items)) { expect(frame.value.items.length).toBeLessThanOrEqual(128); expect(Buffer.byteLength(JSON.stringify(frame.value))).toBeLessThanOrEqual(512 * 1024); } }
        resultValue(await raw.call('content.release', [value.ref]));
    });
    it('an oversized metadata record is refused visibly instead of silently skipped', async () => {
        const f = await fixture(); await f.index([post({ id: 'oversized-title', title: 'x'.repeat(600 * 1024) })]); const raw = await f.raw(), value = await body(f, raw);
        const first = await raw.call('page.open', ['artboard-posts', value.list]), second = await raw.call('page.open', ['artboard-posts', value.list]);
        expect(first).toMatchObject({ kind: 'result', ok: false, reason: expect.stringMatching(/record 0.*[0-9]/) }); expect(second).toMatchObject({ kind: 'result', ok: false, reason: (first as { reason: string }).reason });
        resultValue(await raw.call('content.release', [value.ref]));
    });
    it('a full 2 MiB image and large HTML survive with complete native bytes and no large call/event', async () => {
        const f = await fixture(), bytes = new Uint8Array(2 * 1024 * 1024).fill(0xa5), html = '<p>' + '雪'.repeat(800000) + '</p>';
        await writeFile(join(f.board, 'image.png'), bytes); await writeFile(join(f.board, 'large.html'), html);
        await f.index([post({ id: 'image', kind: 'image', file: 'image.png' }), post({ id: 'html', file: 'large.html' })]);
        const board = await f.bridge().read('work'), image = board.posts.find(p => p.id === 'image')!;
        expect(Buffer.from(image.src!.split(',')[1]!, 'base64').equals(Buffer.from(bytes))).toBe(true); expect(board.posts.find(p => p.id === 'html')!.html).toBe(html);
        expect(f.calls.some(c => c.method === 'blob.open' && c.args[0] === 'artboard-post')).toBe(true); expect(f.calls.some(c => c.method === 'content.release')).toBe(true);
        for (const text of f.serialized) { const frame = JSON.parse(text); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024); if (frame.kind === 'call' || frame.kind === 'event') expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512 * 1024); }
    });
    it('a corrupted image blob fails the hash check and releases resources; a real retry succeeds', async () => {
        const f = await fixture(), bytes = new Uint8Array([1, 2, 3]); await writeFile(join(f.board, 'image.png'), bytes); await f.index([post({ kind: 'image', file: 'image.png' })]); let changed = false;
        f.rewrite.frame = text => { const frame = JSON.parse(text); if (!changed && frame.kind === 'result' && typeof frame.value?.base64 === 'string') { changed = true; frame.value.base64 = 'BAUG'; return JSON.stringify(frame); } return text; };
        await expect(f.bridge().read('work')).rejects.toThrow(/hash/i); expect(changed).toBe(true); expect(f.calls.some(c => c.method === 'blob.close')).toBe(true); expect(f.calls.some(c => c.method === 'content.release')).toBe(true);
        f.rewrite.frame = text => text; expect(await f.bridge().read('work')).toEqual(await f.native());
    });
    it('ArtBoard image reads retain their native limit rather than inheriting the Files eight MiB cap', async () => {
        const f = await fixture(), bytes = new Uint8Array(8 * 1024 * 1024 + 1).fill(37); await writeFile(join(f.board, 'image.png'), bytes); await f.index([post({ kind: 'image', file: 'image.png' })]);
        const board = await f.bridge().read('work'); expect(Buffer.from(board.posts[0]!.src!.split(',')[1]!, 'base64').equals(Buffer.from(bytes))).toBe(true);
    });
    it('snapshots, pages and blobs belong to their connection and expire or release together', async () => {
        let now = Date.now(); const f = await fixture({ now: () => now }), a = await f.raw(), b = await f.raw(), value = await body(f, a);
        const page = resultValue<{ items: Metadata[] }>(await a.call('page.open', ['artboard-posts', value.list])), ref = page.items[0]!.artifact.ref;
        expect(await b.call('page.open', ['artboard-posts', value.list])).toMatchObject({ kind: 'result', ok: false }); expect(await b.call('blob.open', ['artboard-post', ref])).toMatchObject({ kind: 'result', ok: false });
        resultValue(await a.call('content.release', [value.ref])); expect(await a.call('blob.open', ['artboard-post', ref])).toMatchObject({ kind: 'result', ok: false });
        const later = await body(f, a); now += LOCAL_UPLOAD_TTL_MS + 1; expect(await a.call('page.open', ['artboard-posts', later.list])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringMatching(/expired|released/i) });
    });
    it('ArtBoard responses share the eight-response quota and free it on release', async () => {
        const f = await fixture(), raw = await f.raw(), values = [];
        for (let i = 0; i < 8; i++) values.push(await body(f, raw));
        expect(await raw.call('artboard.read', ['work'])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringMatching(/8|eight|many/i) });
        resultValue(await raw.call('content.release', [values[0]!.ref])); expect((await body(f, raw)).count).toBe(1);
    });
    it('review preserves trim, persisted verdict and delivery to the recorded posting agent', async () => {
        const f = await fixture(); expect(await f.bridge().review('work', 'p1', 'rejected', '  fix the spacing 雪  ')).toEqual({ ok: true, delivered: true });
        const board = await f.native(); expect(board.posts[0]!.review).toEqual({ verdict: 'rejected', at: f.deps.now(), comment: 'fix the spacing 雪' });
        expect(f.sent).toHaveLength(1); expect(f.sent[0]!.agentId).toBe('agent_a'); expect(f.sent[0]!.text).toContain('fix the spacing 雪');
        expect(f.ports.review).toHaveBeenCalledWith('work', 'p1', 'rejected', '  fix the spacing 雪  ');
    });
    it('unknown workspace, missing post, invalid verdict and opt-out keep native refusals', async () => {
        const f = await fixture(), bridge = f.bridge();
        expect(await bridge.review('gone', 'p1', 'approved', undefined as never)).toEqual({ ok: false, error: 'Genie does not have that workspace' });
        expect(await bridge.review('work', 'gone', 'approved', undefined as never)).toEqual({ ok: false, error: 'That post is no longer on the board.' });
        expect(await bridge.review('work', 'p1', 'maybe' as never, undefined as never)).toEqual({ ok: false, error: 'bad arguments' });
        await f.index([post({ askVerdict: false })]); expect(await bridge.review('work', 'p1', 'approved', undefined as never)).toEqual({ ok: false, error: 'That post did not ask for a verdict.' }); expect(f.sent).toEqual([]);
    });
    it('a post with no recorded agent is saved without a delivery, and nonstring comments remain ignored', async () => {
        const f = await fixture(), noAgent = post(); delete noAgent.agentId; await f.index([noAgent]); const circular: Record<string, unknown> = {}; circular.self = circular;
        for (const comment of [undefined, null, 12n, circular]) expect(await f.bridge().review('work', 'p1', 'approved', comment as never)).toEqual({ ok: true, delivered: false });
        expect((await f.native()).posts[0]!.review).toEqual({ verdict: 'approved', at: f.deps.now() }); expect(f.sent).toEqual([]);
    });
    it('large review text stages with its own purpose, preserves Unicode and never travels in a large call', async () => {
        const f = await fixture(), comment = '雪'.repeat(400000) + '\ud800';
        expect(await f.bridge().review('work', 'p1', 'approved', comment)).toEqual({ ok: true, delivered: true });
        expect((await f.native()).posts[0]!.review!.comment).toBe(comment); expect(f.calls.some(c => c.method === 'localUpload.begin' && (c.args[0] as { purpose: string; subtype: string }).purpose === 'board-image' && (c.args[0] as { subtype: string }).subtype === 'comment')).toBe(true);
        expect(f.calls.some(c => c.method === 'localUpload.abort')).toBe(true);
        for (const text of f.serialized) { const frame = JSON.parse(text); if (frame.kind === 'call' || frame.kind === 'event') expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512 * 1024); }
    });
    it('small review text remains inline and a raw oversized comment is refused before the native port', async () => {
        const f = await fixture(); await f.bridge().review('work', 'p1', 'approved', 'small'); expect(f.calls.some(c => c.method === 'localUpload.begin')).toBe(false);
        const raw = await f.raw(); f.ports.review.mockClear(); expect(await raw.call('artboard.review', ['work', 'p1', 'approved', 'x'.repeat(600 * 1024)])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringMatching(/staging|bounded|large/i) }); expect(f.ports.review).not.toHaveBeenCalled();
    });
    it('review text over the new 100 MiB staging payload ceiling is refused before any stage or native write', async () => {
        const f = await fixture(), bridge = f.bridge(); f.ports.review.mockClear();
        await expect(bridge.review('work', 'p1', 'approved', 'x'.repeat(100 * 1024 * 1024))).rejects.toThrow(/100|104857600|large|size|upload/i);
        expect(f.calls.some(c => c.method === 'localUpload.begin')).toBe(false); expect(f.ports.review).not.toHaveBeenCalled(); expect(f.sent).toEqual([]);
    });
    it('staged comments are connection-owned and taken once by review only', async () => {
        const f = await fixture(), a = await f.raw(), b = await f.raw(), id = await staged(a, JSON.stringify('a complete staged comment'));
        expect(await b.call('artboard.review', ['work', 'p1', 'approved', { staged: id }])).toMatchObject({ kind: 'result', ok: false });
        expect(resultValue(await a.call('artboard.review', ['work', 'p1', 'approved', { staged: id }]))).toEqual({ ok: true, delivered: true });
        expect(await a.call('artboard.review', ['work', 'p1', 'approved', { staged: id }])).toMatchObject({ kind: 'result', ok: false }); expect(f.sent).toHaveLength(1);
    });
    it('review cannot consume another purpose and malformed staged JSON is cleaned without writing a verdict', async () => {
        const f = await fixture(), raw = await f.raw(), wrong = await staged(raw, JSON.stringify('wrong purpose'), 'file-write', 'text');
        expect(await raw.call('artboard.review', ['work', 'p1', 'approved', { staged: wrong }])).toMatchObject({ kind: 'result', ok: false }); expect(resultValue(await raw.call('localUpload.abort', [wrong]))).toEqual({ aborted: true });
        const malformed = await staged(raw, 'not json'); expect(await raw.call('artboard.review', ['work', 'p1', 'approved', { staged: malformed }])).toMatchObject({ kind: 'result', ok: false });
        expect(resultValue(await raw.call('localUpload.abort', [malformed]))).toEqual({ aborted: false }); expect((await f.native()).posts[0]!.review).toBeUndefined(); expect(f.sent).toEqual([]);
    });
    it('duplicate native post IDs remain ordered entries rather than being silently deduplicated', async () => {
        const f = await fixture(); await f.index([post({ title: 'First' }), post({ title: 'Second' })]); expect(await f.bridge().read('work')).toEqual(await f.native());
    });
    it('native Unicode and long post IDs survive the bounded page cursor IDs unchanged', async () => {
        const f = await fixture(); await f.index([post({ id: '雪 / native id' }), post({ id: 'x'.repeat(2000), title: 'Long native id' })]);
        expect(await f.bridge().read('work')).toEqual(await f.native());
    });
    it('a native read failure rejects visibly and releases the pending response budget', async () => {
        const f = await fixture(); f.ports.read.mockRejectedValueOnce(new Error('synthetic board disk refusal'));
        await expect(f.bridge().read('work')).rejects.toThrow('synthetic board disk refusal'); expect(await f.bridge().read('work')).toEqual(await f.native());
    });
    it('pageBridge uses the same local client, with no retired native fallback, including recovery', async () => {
        const f = await fixture(), port = f.port(); let handle = '';
        vi.stubGlobal('window', { genieLocalProtocol: { ...port, send: (action: 'open' | 'frame' | 'close', id: string, text: string) => { if (action === 'open') handle = id; port.send(action, id, text); } } });
        const retired = vi.fn(() => { throw new Error('retired native ArtBoard call'); }), preload = { subscribeAgentWire: () => () => {}, workspaces: {}, files: {}, artboard: { read: retired, review: retired } } as unknown as PreloadBridge;
        const bridge = pageBridge(preload); expect(await bridge.artboard!.read('work')).toEqual(await f.native()); expect(retired).not.toHaveBeenCalled();
        port.send('close', handle, ''); await tick(); await tick(); bridge.localProtocol!.retry(); await vi.waitFor(() => expect(bridge.localProtocol!.state().phase).toBe('ready'));
        expect(pageBridge(preload)).toBe(bridge); expect(await bridge.artboard!.review('work', 'p1', 'approved', undefined as never)).toEqual({ ok: true, delivered: true }); expect(retired).not.toHaveBeenCalled();
    });
    it.each(['src/main/main.ts', 'src/main/preload.ts', 'src/core/ipc-inventory.ts'])('retires both native ArtBoard paths in %s', path => {
        const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
        expect(text).not.toContain("'genie:artboard-read'"); expect(text).not.toContain("'genie:artboard-review'");
    });
});
