import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BLOB_READ_BYTES, type BlobSource } from '../src/core/local-blobs.js';
import { LocalFilesContent } from '../src/main/local-files-content.js';

const load = async () => { const file: string = '../src/main/artboard-files.js'; return import(file); };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(count = 100) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'genie-artboard-file-sources-'))), board = join(root, '.artboard'); await mkdir(board);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bytes = Buffer.alloc(2 * 1024 * 1024, 37), html = '<h1>Body must not be loaded by a list</h1>';
    await writeFile(join(board, 'image.png'), bytes); await writeFile(join(board, 'post.html'), html);
    await writeFile(join(board, 'index.json'), JSON.stringify({ posts: Array.from({ length: count }, (_, i) => ({ id: 'p' + i, title: 'Post ' + i, kind: i === 0 ? 'image' : 'html', file: i === 0 ? 'image.png' : 'post.html', createdAt: '2026-11-06T00:00:00Z', askVerdict: false })) }));
    const handles: Array<{ path: string; read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const io = {
        readFile: vi.fn((path: string) => readFile(path, 'utf8')), lstat, realpath,
        open: vi.fn(async (path: string, flags: number) => {
            const held = await open(path, flags), reader = vi.fn(held.read.bind(held)), close = vi.fn(() => held.close());
            handles.push({ path, read: reader, close }); return { read: reader, stat: held.stat.bind(held), close };
        }),
    };
    return { root, board, bytes, html, io, handles };
}

it('a 100-post metadata read touches no artifact bytes, encodes no image, and opens no artifact handle', async () => {
    const f = await fixture(), { readArtboardFiles } = await load(), board = await readArtboardFiles(f.root, f.io);
    expect(board.posts).toHaveLength(100); expect(f.io.readFile).toHaveBeenCalledExactlyOnceWith(join(f.board, 'index.json'));
    expect(f.io.open).not.toHaveBeenCalled(); expect(f.handles).toEqual([]);
    expect(board.posts.find((post: { id: string }) => post.id === 'p0').artifact).toMatchObject({ size: f.bytes.length, type: 'image/png' });
    expect(JSON.stringify(board)).not.toContain(f.html); expect(JSON.stringify(board)).not.toContain('data:image');
});
it('the local metadata page has stat size and sha256:null, with no host path or artifact content', async () => {
    const f = await fixture(), { readArtboardFiles } = await load(), content = new LocalFilesContent(), ref = content.begin();
    cleanups.push(async () => content.dispose());
    const result = content.artboardResult(ref, await readArtboardFiles(f.root, f.io)) as { artboardContent: { list: string } };
    const page = await content.pages.open('artboard-posts', result.artboardContent.list), image = page.items.find(item => item.postId === 'p0')!;
    expect(image.artifact).toMatchObject({ size: f.bytes.length, sha256: null, type: 'image/png' });
    expect(JSON.stringify(page)).not.toContain(f.root); expect(JSON.stringify(page)).not.toContain('image.png'); expect(f.io.open).not.toHaveBeenCalled();
});
it('opening one image streams and hashes only that file, and range reads preserve every byte', async () => {
    const f = await fixture(), { readArtboardFiles } = await load(), board = await readArtboardFiles(f.root, f.io);
    const image = board.posts.find((post: { id: string }) => post.id === 'p0'), source: BlobSource = await image.artifact.open();
    cleanups.push(() => source.close());
    expect(f.io.open).toHaveBeenCalledTimes(1); expect(f.handles[0]!.path).toBe(join(f.board, 'image.png'));
    expect(source.size).toBe(f.bytes.length); expect(source.sha256).toBe(hash(f.bytes));
    expect(f.handles[0]!.read.mock.calls.every(call => (call[0] as Uint8Array).byteLength <= BLOB_READ_BYTES)).toBe(true);
    const actual: Buffer[] = []; for (let at = 0; at < source.size; at += BLOB_READ_BYTES) actual.push(Buffer.from(await source.read(at, Math.min(BLOB_READ_BYTES, source.size - at))));
    expect(Buffer.concat(actual).equals(f.bytes)).toBe(true); await expect(source.read(0, BLOB_READ_BYTES + 1)).rejects.toThrow(/bounded|512|524288|range/i);
    await source.close(); await source.close(); expect(f.handles[0]!.close).toHaveBeenCalledTimes(1);
});
it('HTML is a file source too, without reading the other image', async () => {
    const f = await fixture(2), { readArtboardFiles } = await load(), board = await readArtboardFiles(f.root, f.io);
    const source: BlobSource = await board.posts.find((post: { id: string }) => post.id === 'p1').artifact.open(); cleanups.push(() => source.close());
    expect(source.sha256).toBe(hash(Buffer.from(f.html))); expect(Buffer.from(await source.read(0, source.size)).toString()).toBe(f.html);
    expect(f.handles.map(handle => handle.path)).toEqual([join(f.board, 'post.html')]);
});
it('a missing artifact stays listed with its stat failure and refuses a blob open in words', async () => {
    const f = await fixture(1); await rm(join(f.board, 'image.png'));
    const { readArtboardFiles } = await load(), board = await readArtboardFiles(f.root, f.io);
    expect(board.posts).toHaveLength(1); expect(board.posts[0].artifact).toMatchObject({ size: null, error: expect.stringMatching(/missing|not found|ENOENT/i) });
    await expect(board.posts[0].artifact.open()).rejects.toThrow(/missing|not found|ENOENT/i); expect(f.io.open).not.toHaveBeenCalled();
});
it('a symlink outside the board cannot become an artifact source or expose foreign bytes', async () => {
    const f = await fixture(1), foreign = join(f.root, 'outside.png'); await writeFile(foreign, 'outside-secret'); await rm(join(f.board, 'image.png')); await symlink(foreign, join(f.board, 'image.png'), 'file');
    const { readArtboardFiles } = await load(), board = await readArtboardFiles(f.root, f.io);
    expect(board.posts).toHaveLength(1); await expect(board.posts[0].artifact.open()).rejects.toThrow(/confined|symbolic|regular|board/i);
    expect(f.io.open).not.toHaveBeenCalled(); expect(JSON.stringify(board)).not.toContain('outside-secret');
});
it.each(['size', 'same-size'])('refuses a %s artifact edit between stat-only listing and blob.open', async change => {
    const f = await fixture(1), { readArtboardFiles } = await load(), board = await readArtboardFiles(f.root, f.io);
    await writeFile(join(f.board, 'image.png'), change === 'size' ? 'changed' : Buffer.alloc(f.bytes.length, 38));
    await expect(board.posts[0].artifact.open()).rejects.toThrow(/changed|size|version/i);
});
it('detects an edit after opening instead of serving bytes under an old hash', async () => {
    const f = await fixture(1), { readArtboardFiles } = await load(), board = await readArtboardFiles(f.root, f.io), source: BlobSource = await board.posts[0].artifact.open(); cleanups.push(() => source.close());
    await writeFile(join(f.board, 'image.png'), Buffer.alloc(f.bytes.length, 38)); await expect(source.read(0, 64)).rejects.toThrow(/changed|size|version/i);
});
it('release of a content response closes the file source and forbids stale refs', async () => {
    const f = await fixture(1), { readArtboardFiles } = await load(), content = new LocalFilesContent(), ref = content.begin(); cleanups.push(async () => content.dispose());
    const result = content.artboardResult(ref, await readArtboardFiles(f.root, f.io)) as { artboardContent: { list: string } }, page = await content.pages.open('artboard-posts', result.artboardContent.list);
    const artifact = page.items[0]!.artifact as { ref: string }, opened = await content.blobs.open('artboard-post', artifact.ref);
    await content.releaseAndWait(ref); expect(f.handles[0]!.close).toHaveBeenCalledTimes(1);
    await expect(content.blobs.read(opened.id, 0, 1)).rejects.toThrow(/open|closed/i); await expect(content.blobs.open('artboard-post', artifact.ref)).rejects.toThrow(/ref|content/i);
});
