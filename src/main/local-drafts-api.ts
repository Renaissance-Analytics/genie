import { createHash } from 'node:crypto';
import { BLOB_READ_BYTES, type BlobSource } from '../core/local-blobs.js';
import type { ChatDrafts } from '../core/chat-drafts.js';
import { DRAFT_CALL_BYTES, type LocalDraftMethod } from '../core/local-drafts.js';
import { MAX_DRAFT_FILE_BYTES } from './chat-draft-store.js';
import type { LocalUploads } from './local-uploads.js';

/** Both the native store and genie-host's existing store replica satisfy these ports. */
export interface LocalDraftsStore {
    all(): ChatDrafts | Promise<ChatDrafts>;
    save(agentId: string, raw: unknown): Promise<void>;
    putFile(bytes: Uint8Array): Promise<string>;
    readFile(ref: unknown): Promise<Uint8Array | BlobSource | null>;
    release(refs: readonly unknown[]): Promise<void>;
}
export function invokeLocalDrafts(store: LocalDraftsStore | undefined, find: (id: string) => unknown, method: LocalDraftMethod, args: unknown[]): unknown {
    if (!store) throw new Error('this Genie does not keep chat drafts');
    switch (method) {
        case 'chatDrafts.load': return store.all();
        case 'chatDrafts.save': return typeof args[0] === 'string' && (args[1] === null || find(args[0])) ? store.save(args[0], args[1]) : undefined;
        case 'chatDrafts.putFile': return args[0] instanceof Uint8Array && args[0].byteLength <= MAX_DRAFT_FILE_BYTES ? store.putFile(args[0]) : null;
        case 'chatDrafts.readFile': return store.readFile(args[0]);
        case 'chatDrafts.release': return Array.isArray(args[0]) ? store.release(args[0]) : undefined;
    }
}

/** Fixed consumers: only save takes draft-file/text, only putFile takes draft-file/attachment. */
export async function localDraftArguments(method: LocalDraftMethod, args: unknown[], uploads: LocalUploads | null): Promise<{ args: unknown[]; close(): Promise<void> }> {
    if (Buffer.byteLength(JSON.stringify(args)) > DRAFT_CALL_BYTES) throw new Error('large draft content must use local staging');
    const index = method === 'chatDrafts.save' ? 1 : method === 'chatDrafts.putFile' ? 0 : -1, value = args[index];
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'staged')) return { args, close: async () => {} };
    const id = (value as { staged?: unknown }).staged, subtype = method === 'chatDrafts.save' ? 'text' : 'attachment';
    const source = typeof id === 'string' ? await uploads?.take(id, 'draft-file', subtype) : null;
    if (!source) throw new Error(`no complete draft-file/${subtype} stage on this connection`);
    try {
        const bytes = Buffer.alloc(source.size), hash = createHash('sha256');
        for (let at = 0; at < bytes.length; at += BLOB_READ_BYTES) {
            const length = Math.min(BLOB_READ_BYTES, bytes.length - at), chunk = await source.read(at, length);
            if (chunk.byteLength !== length) throw new Error('the local draft stage ended early');
            bytes.set(chunk, at); hash.update(chunk);
        }
        if (hash.digest('hex') !== source.sha256) throw new Error('the local draft stage hash changed');
        const materialized = [...args]; materialized[index] = method === 'chatDrafts.save' ? JSON.parse(bytes.toString('utf8')) as unknown : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { args: materialized, close: () => source.close() };
    } catch (error) { try { await source.close(); } catch { console.warn('[genie] a failed draft stage could not be released'); } throw error; }
}
