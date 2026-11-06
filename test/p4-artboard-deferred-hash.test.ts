import { createHash, webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { verifiedBlobClient } from '../src/renderer/blob-reader.js';
import { localArtboardClient } from '../src/renderer/local-artboard-client.js';

afterEach(() => vi.unstubAllGlobals());
function fixture(options: { size?: number; hash?: string; missing?: boolean } = {}) {
    vi.stubGlobal('crypto', webcrypto);
    const bytes = Buffer.from([0, 1, 255]), digest = createHash('sha256').update(bytes).digest('hex');
    const calls = { open: vi.fn(async () => ({ id: 'opened', size: bytes.length, sha256: options.hash ?? digest })), read: vi.fn(async (_id: string, offset: number, length: number) => ({ base64: bytes.subarray(offset, offset + length).toString('base64') })), close: vi.fn(async () => ({ closed: true })) };
    const artifact = { ref: 'artifact', size: options.missing ? null : options.size ?? bytes.length, sha256: null, type: 'image/png', ...(options.missing ? { error: 'The artifact file is missing from the board.' } : {}) };
    const release = vi.fn(async () => ({ released: true })), blobs = verifiedBlobClient(calls);
    const port = { read: vi.fn(async () => ({ artboardContent: { ref: 'response', list: 'list', count: 1 } })), release, blobs,
        pages: { readAll: vi.fn(async () => [{ id: '0', postId: 'p1', title: 'Image', kind: 'image', createdAt: '2026-11-06T00:00:00Z', askVerdict: false, artifact }]) }, uploads: {} };
    return { bytes, calls, artifact, release, bridge: localArtboardClient(port as unknown as Parameters<typeof localArtboardClient>[0]) };
}
it('accepts sha256:null in file metadata and verifies the complete image against the hash from blob.open', async () => {
    const f = fixture(), board = await f.bridge.read('work');
    expect(board.posts[0]!.src).toBe('data:image/png;base64,' + f.bytes.toString('base64')); expect(f.calls.open).toHaveBeenCalledExactlyOnceWith('artboard-post', 'artifact');
    expect(f.calls.close).toHaveBeenCalledExactlyOnceWith('opened'); expect(f.release).toHaveBeenCalledExactlyOnceWith('response');
});
it('a wrong blob.open hash is refused and the opened source and response are released', async () => {
    const f = fixture({ hash: '0'.repeat(64) }); await expect(f.bridge.read('work')).rejects.toThrow(/hash/i);
    expect(f.calls.read).toHaveBeenCalled(); expect(f.calls.close).toHaveBeenCalledExactlyOnceWith('opened'); expect(f.release).toHaveBeenCalledExactlyOnceWith('response');
});
it('refuses a difference between stat-only list size and opened content size', async () => {
    const f = fixture({ size: 4 }); await expect(f.bridge.read('work')).rejects.toThrow(/size/i); expect(f.release).toHaveBeenCalledExactlyOnceWith('response');
});
it('a missing artifact is a visible post failure and does not try to open an unreadable file', async () => {
    const f = fixture({ missing: true }), board = await f.bridge.read('work');
    expect(board.posts).toHaveLength(1); expect(board.posts[0]).toMatchObject({ id: 'p1', title: 'Image', contentError: f.artifact.error });
    expect(board.posts[0]).not.toHaveProperty('src'); expect(f.calls.open).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledExactlyOnceWith('response');
});
