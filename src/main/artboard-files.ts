import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { BOARD_DIR, BOARD_INDEX, parseBoard, wantsVerdict, type BoardPost } from '../core/artboard.js';
import { BLOB_READ_BYTES, type BlobSource } from '../core/local-blobs.js';
import { beginArtboardBuildTiming } from './artboard-build-timing.js';

interface ArtifactHandle {
    stat(options: { bigint: true }): Promise<BigIntStats>;
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
}
interface ArtifactIo {
    readFile(path: string): Promise<string>;
    lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
    realpath(path: string): Promise<string>;
    open(path: string, flags: number): Promise<ArtifactHandle>;
}
export interface ArtboardArtifact {
    size: number | null; type: string; error?: string;
    open(options?: { signal?: AbortSignal }): Promise<BlobSource>;
}
export interface ArtboardFilePost extends Omit<BoardPost, 'file' | 'agentId' | 'askVerdict'> { askVerdict: boolean; artifact: ArtboardArtifact }
export interface ArtboardFilesBoard { posts: ArtboardFilePost[]; error?: string }
const IO: ArtifactIo = { readFile: path => readFile(path, 'utf8'), lstat: (path, options) => lstat(path, options), realpath, open };
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const version = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const changed = () => new Error('The ArtBoard artifact changed since the board was listed; refresh the board.');
const inspectionError = (error: unknown): string => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' ? 'The artifact file is missing from the board.'
        : `The ArtBoard artifact could not be inspected${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ''}.`;
};

/** Listing reads only the index and filesystem metadata. Artifact bytes and hashes wait for blob.open. */
export async function readArtboardFiles(root: string, io: ArtifactIo = IO): Promise<ArtboardFilesBoard> {
    const finish = beginArtboardBuildTiming('metadata-build', 'async');
    try {
        const directory = join(root, BOARD_DIR);
        let canonical: string;
        try {
            const stat = await io.lstat(directory, { bigint: true });
            if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('not a regular board directory'); // BREAK PROBE: a linked board folder is followed
            canonical = await io.realpath(directory);
        } catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { posts: [] } : { posts: [], error: 'The ArtBoard directory could not be inspected.' }; }
        let posts: BoardPost[];
        try {
            const index = join(directory, BOARD_INDEX), stat = await io.lstat(index, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular board index');
            posts = parseBoard(await io.readFile(index));
        } catch { return { posts: [] }; }
        const out: ArtboardFilePost[] = [];
        for (const post of posts) {
            const type = post.kind === 'html' ? 'text/html' : IMAGE_TYPES[extname(post.file).toLowerCase()];
            let error: string | undefined, stat: BigIntStats | undefined;
            const path = join(canonical, post.file);
            if (!type) error = 'The ArtBoard image type is not supported.';
            else {
                try {
                    stat = await io.lstat(path, { bigint: true });
                    if (!stat.isFile() || stat.isSymbolicLink() || relative(path, await io.realpath(path)) !== '') { stat = undefined; error = 'The ArtBoard artifact must be a regular file confined to the board.'; }
                    else if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) { stat = undefined; error = 'The ArtBoard artifact size cannot be represented safely.'; }
                } catch (failure) { error = inspectionError(failure); }
            }
            const listed = stat;
            const artifact: ArtboardArtifact = {
                size: listed ? Number(listed.size) : null, type: type ?? 'application/octet-stream', ...(error ? { error } : {}),
                open: async (options = {}) => {
                    if (!listed || error) throw new Error(error ?? 'The ArtBoard artifact metadata is unavailable.');
                    return openArtifact(io, canonical, post.file, listed, options.signal);
                },
            };
            out.push({ id: post.id, title: post.title, kind: post.kind, createdAt: post.createdAt, askVerdict: wantsVerdict(post), artifact,
                ...(post.note ? { note: post.note } : {}), ...(post.review ? { review: post.review } : {}) });
        }
        return { posts: out };
    } finally { finish(); }
}

async function openArtifact(io: ArtifactIo, directory: string, name: string, listed: BigIntStats, signal?: AbortSignal): Promise<BlobSource> {
    const finish = beginArtboardBuildTiming('artifact-open', 'async');
    let file: ArtifactHandle | null = null;
    try {
        signal?.throwIfAborted();
        const path = join(directory, name), current = await io.lstat(path, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || relative(path, await io.realpath(path)) !== '') throw new Error('The ArtBoard artifact is not confined to the board.');
        if (version(current) !== version(listed)) throw changed();
        file = await io.open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
        const stat = await file.stat({ bigint: true });
        if (!stat.isFile() || version(stat) !== version(listed)) throw changed();
        const size = Number(stat.size), hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(BLOB_READ_BYTES, size));
        for (let at = 0; at < size;) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - at), at);
            if (!bytesRead) throw changed(); hash.update(buffer.subarray(0, bytesRead)); at += bytesRead;
        }
        signal?.throwIfAborted(); if (version(await file.stat({ bigint: true })) !== version(stat)) throw changed();
        const held = file; file = null; let closed = false;
        return {
            size, sha256: hash.digest('hex'),
            read: async (offset, length) => {
                if (closed || signal?.aborted) throw new Error('The ArtBoard artifact source is closed.');
                if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > BLOB_READ_BYTES || offset > size || length > size - offset) throw new Error('The ArtBoard artifact range must be within its size and at most 524288 bytes.');
                if (version(await held.stat({ bigint: true })) !== version(stat)) throw changed();
                const bytes = Buffer.alloc(length);
                for (let at = 0; at < length;) {
                    const { bytesRead } = await held.read(bytes, at, length - at, offset + at);
                    if (!bytesRead) throw changed(); at += bytesRead;
                }
                if (closed || signal?.aborted) throw new Error('The ArtBoard artifact source closed during its read.');
                if (version(await held.stat({ bigint: true })) !== version(stat)) throw changed(); return bytes;
            },
            close: async () => { if (closed) return; closed = true; await held.close(); },
        };
    } catch (error) {
        if (error instanceof Error && (error.message.startsWith('The ArtBoard') || error.name === 'AbortError')) throw error;
        throw new Error(inspectionError(error));
    } finally { try { await file?.close(); } finally { finish(); } }
}
