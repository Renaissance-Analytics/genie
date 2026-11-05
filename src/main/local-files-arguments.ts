import { createHash } from 'node:crypto';
import { BLOB_READ_BYTES } from '../core/local-blobs.js';
import { FILES_INLINE_BYTES, type LocalFilesMethod } from '../core/local-files.js';
import type { LocalUploads } from './local-uploads.js';

/** Materialize only the fixed consuming call/subtype after the host's local gate. */
export async function localFilesArguments(method: LocalFilesMethod, args: unknown[], uploads: LocalUploads | null): Promise<{ args: unknown[]; close(): Promise<void> }> {
    const index = method === 'files.write' ? 2 : method === 'files.writeBytes' ? 3 : method === 'repo.call' && args.length === 1 ? 0 : -1;
    const value = index >= 0 ? args[index] : null;
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'staged')) {
        if (Buffer.byteLength(JSON.stringify(args)) > FILES_INLINE_BYTES) throw new Error('large Files or repository content must use local staging');
        return { args, close: async () => {} };
    }
    const id = (value as { staged?: unknown }).staged;
    const subtype = method === 'files.write' ? 'text' : method === 'files.writeBytes' ? 'bytes' : 'repo-args';
    const source = typeof id === 'string' ? await uploads?.take(id, 'file-write', subtype) : null;
    if (!source) throw new Error(`no complete file-write/${subtype} stage on this connection`);
    try {
        const bytes = Buffer.alloc(source.size), hash = createHash('sha256');
        for (let at = 0; at < bytes.length; at += BLOB_READ_BYTES) {
            const chunk = await source.read(at, Math.min(BLOB_READ_BYTES, bytes.length - at));
            if (chunk.length !== Math.min(BLOB_READ_BYTES, bytes.length - at)) throw new Error('the local file stage ended early');
            bytes.set(chunk, at); hash.update(chunk);
        }
        if (hash.digest('hex') !== source.sha256) throw new Error('the local file stage hash changed');
        let materialized: unknown[];
        if (subtype === 'repo-args') {
            const parsed: unknown = JSON.parse(bytes.toString('utf8'));
            if (!Array.isArray(parsed) || parsed.length !== 5) throw new Error('a repository argument stage needs its five native arguments');
            materialized = parsed;
        } else { materialized = [...args]; materialized[index] = bytes.toString(subtype === 'bytes' ? 'base64' : 'utf8'); }
        return { args: materialized, close: () => source.close() };
    } catch (error) { await source.close(); throw error; }
}
