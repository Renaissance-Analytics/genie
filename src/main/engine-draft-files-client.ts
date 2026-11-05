import type { EngineMethod } from '../core/engine-protocol.js';
import { isDraftRef } from '../core/chat-drafts.js';
import { BLOB_READ_BYTES, type BlobSource } from '../core/local-blobs.js';
import type { LocalDraftsStore } from './local-drafts-api.js';

type Method = Extract<EngineMethod, 'engine.drafts.fileOpen' | 'engine.drafts.fileRead' | 'engine.drafts.fileClose'>;
type Reply = { ok: true; value: unknown } | { ok: false; reason: string };
type Caller = (method: Method, args: unknown[]) => Promise<Reply>;
interface FileInfo { handle: string; size: number; sha256: string }

/** Main holds metadata and bounded ranges. File resolution, hashing and handles remain in genie-host. */
export function engineDraftsPort(store: Pick<LocalDraftsStore, 'all' | 'save' | 'putFile' | 'release'>, call: Caller): LocalDraftsStore {
    const request = async <T>(method: Method, args: unknown[]): Promise<T> => { const reply = await call(method, args); if (!reply.ok) throw new Error(reply.reason); return reply.value as T; };
    const closeHandle = async (handle: string): Promise<void> => {
        const reply = await call('engine.drafts.fileClose', [handle]);
        // Disconnect/idle expiry already closed the host's handle; release stays idempotent at its owning scope.
        if (!reply.ok && !/not connected|closed|no such.*handle/i.test(reply.reason)) throw new Error(reply.reason);
    };
    return {
        all: () => store.all(), save: (id, raw) => store.save(id, raw), putFile: bytes => store.putFile(bytes), release: refs => store.release(refs),
        readFile: async ref => {
            if (!isDraftRef(ref)) return null;
            const info = await request<FileInfo | null>('engine.drafts.fileOpen', [ref]); if (info === null) return null;
            if (!info || typeof info.handle !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(info.handle) || !Number.isSafeInteger(info.size) || info.size < 0 || typeof info.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(info.sha256)) {
                if (info && typeof info.handle === 'string') await closeHandle(info.handle);
                throw new Error('invalid host draft file metadata');
            }
            let closing: Promise<void> | null = null;
            const source: BlobSource = {
                size: info.size, sha256: info.sha256,
                read: async (offset, length) => {
                    if (closing) throw new Error('the draft source is closed');
                    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > BLOB_READ_BYTES || offset > info.size || length > info.size - offset) throw new Error('the draft read is outside its bounded size');
                    const result = await request<{ base64: string }>('engine.drafts.fileRead', [info.handle, offset, length]);
                    if (closing) throw new Error('the draft source closed during its read');
                    if (!result || typeof result.base64 !== 'string' || result.base64.length !== 4 * Math.ceil(length / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) throw new Error('invalid bounded draft bytes from the host');
                    const bytes = Buffer.from(result.base64, 'base64'); if (bytes.length !== length) throw new Error('the host draft read omitted bytes'); return bytes;
                },
                close: () => closing ??= closeHandle(info.handle),
            };
            return source;
        },
    };
}
