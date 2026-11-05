import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResolvedBoard } from '../src/core/artboard.js';

afterEach(() => vi.unstubAllGlobals());
const helper = async () => { const path: string = '../scripts/artboard-measure-page.mjs'; return import(path); };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture(board: ResolvedBoard) {
    const read = vi.fn(async () => board), settings = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', { genieTest: { artboard: { read }, workspaces: { settings } } });
    return { read, settings };
}
it.each(['image', 'html'] as const)('the %s measurement uses the actual page bridge and hashes every artifact byte', async kind => {
    const bytes = new Uint8Array([0, 1, 255]), html = '<h1>Kept 雪</h1>', board: ResolvedBoard = { posts: [{ id: 'p1', title: 'Artifact', kind, createdAt: '2026-11-05T00:00:00Z', askVerdict: false, ...(kind === 'image' ? { src: 'data:image/png;base64,' + Buffer.from(bytes).toString('base64') } : { html }) }] };
    const port = fixture(board), { measureArtboardPage } = await helper();
    const result = await measureArtboardPage({ workspaceId: 'work', postId: 'p1' });
    expect(port.read).toHaveBeenCalledExactlyOnceWith('work'); expect(port.settings).toHaveBeenCalledWith('work');
    expect(result.bytes).toBe(kind === 'image' ? bytes.length : Buffer.byteLength(html)); expect(result.sha256).toBe(sha(kind === 'image' ? bytes : html));
    expect(result.heartbeat.before).toBeGreaterThan(0); expect(result.heartbeat.after).toBeGreaterThan(0); expect(result.concurrentSettings.ok).toBe(true);
});
it('the 100-post measurement counts and hashes the complete native board rather than a prefix', async () => {
    const board: ResolvedBoard = { posts: Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: 'Artifact ' + i, kind: 'html', html: '<p>' + i + '</p>', createdAt: '2026-11-05T00:00:00Z', askVerdict: false })) };
    const port = fixture(board), { measureArtboardPage } = await helper(), result = await measureArtboardPage({ workspaceId: 'work' });
    expect(port.read).toHaveBeenCalledExactlyOnceWith('work'); expect(result.count).toBe(100); expect(result.sha256).toBe(sha(JSON.stringify(board))); expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(board)));
});
it('an absent page ArtBoard bridge refuses without a native fallback', async () => {
    vi.stubGlobal('window', {}); const { measureArtboardPage } = await helper();
    await expect(measureArtboardPage({ workspaceId: 'work' })).rejects.toThrow(/genieTest|ArtBoard|bridge/i);
});
it('the artifact hash check fails on the wrong expected digest, with the real digest as the positive control', async () => {
    const html = '<p>Measured</p>'; fixture({ posts: [{ id: 'p1', title: 'Artifact', kind: 'html', html, createdAt: '2026-11-05T00:00:00Z', askVerdict: false }] });
    const { measureArtboardPage } = await helper();
    await expect(measureArtboardPage({ workspaceId: 'work', postId: 'p1', expect: { sha256: '0'.repeat(64) } })).rejects.toThrow(/hash differs/i);
    expect((await measureArtboardPage({ workspaceId: 'work', postId: 'p1', expect: { sha256: sha(html) } })).sha256).toBe(sha(html));
});
