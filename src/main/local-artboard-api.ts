import { createHash } from 'node:crypto';
import type { ArtboardFilesBoard } from './artboard-files.js';
import { ARTBOARD_CALL_BYTES, type LocalArtboardMethod } from '../core/local-artboard.js';
import { BLOB_READ_BYTES } from '../core/local-blobs.js';
import type { ReviewResult } from './artboard-host.js';
import type { LocalUploads } from './local-uploads.js';

/** The existing native panel functions keep workspace, verdict, persistence and delivery decisions. */
export interface LocalArtboardPort {
    read(workspaceId: unknown): Promise<ArtboardFilesBoard>;
    review(workspaceId: unknown, postId: unknown, verdict: unknown, comment: unknown): Promise<ReviewResult>;
}
export function invokeLocalArtboard(port: LocalArtboardPort | undefined, method: LocalArtboardMethod, args: unknown[]): Promise<unknown> {
    if (!port) throw new Error('this Genie has no ArtBoard host configured');
    return method === 'artboard.read' ? port.read(args[0]) : port.review(args[0], args[1], args[2], args[3]);
}

/** Only artboard.review consumes board-image/comment; text retains the approved 100 MiB serialized stage ceiling. */
export async function localArtboardArguments(method: LocalArtboardMethod, args: unknown[], uploads: LocalUploads | null): Promise<{ args: unknown[]; close(): Promise<void> }> {
    if (Buffer.byteLength(JSON.stringify(args)) > ARTBOARD_CALL_BYTES) throw new Error('large ArtBoard content must use local staging');
    const value = method === 'artboard.review' ? args[3] : null;
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'staged')) return { args, close: async () => {} };
    const id = (value as { staged?: unknown }).staged, source = typeof id === 'string' ? await uploads?.take(id, 'board-image', 'comment') : null;
    if (!source) throw new Error('no complete board-image/comment stage on this connection');
    try {
        const bytes = Buffer.alloc(source.size), hash = createHash('sha256');
        for (let at = 0; at < bytes.length; at += BLOB_READ_BYTES) {
            const length = Math.min(BLOB_READ_BYTES, bytes.length - at), chunk = await source.read(at, length);
            if (chunk.byteLength !== length) throw new Error('the ArtBoard comment stage ended early');
            bytes.set(chunk, at); hash.update(chunk);
        }
        if (hash.digest('hex') !== source.sha256) throw new Error('the ArtBoard comment stage hash changed');
        const comment: unknown = JSON.parse(bytes.toString('utf8'));
        if (typeof comment !== 'string') throw new Error('an ArtBoard comment stage must contain a JSON string');
        const materialized = [...args]; materialized[3] = comment;
        return { args: materialized, close: () => source.close() };
    } catch (error) { try { await source.close(); } catch { console.warn('[genie] a failed ArtBoard stage could not be released'); } throw error; }
}
