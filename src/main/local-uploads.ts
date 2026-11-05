import { createHash, randomUUID, type Hash } from 'node:crypto';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BLOB_READ_BYTES } from '../core/local-blobs.js';
import { LOCAL_UPLOAD_CHUNK_BYTES, LOCAL_UPLOAD_MAX_BYTES, LOCAL_UPLOAD_TTL_MS, MAX_LOCAL_UPLOADS, type LocalUploadInfo, type LocalUploadSource, type LocalUploadTarget } from '../core/local-content.js';
import { restrictPrivateDirectories, restrictPrivateFile } from './private-credentials.js';

/** Host policy, never a max supplied by the window. Previously unlimited writes get the approved staging ceiling. */
export const LOCAL_UPLOAD_RULES = Object.freeze([
    { purpose: 'draft-file', subtype: 'attachment', maxBytes: LOCAL_UPLOAD_MAX_BYTES },
    { purpose: 'draft-file', subtype: 'text', maxBytes: LOCAL_UPLOAD_MAX_BYTES },
    { purpose: 'file-write', subtype: 'text', maxBytes: LOCAL_UPLOAD_MAX_BYTES },
    { purpose: 'file-write', subtype: 'bytes', maxBytes: LOCAL_UPLOAD_MAX_BYTES },
    // TDD boundary probe: the new subtype's full100MiB row must fail before this one-byte restriction is restored.
    { purpose: 'file-write', subtype: 'repo-args', maxBytes: LOCAL_UPLOAD_MAX_BYTES - 1 },
    { purpose: 'board-image', subtype: 'comment', maxBytes: LOCAL_UPLOAD_MAX_BYTES },
].map(rule => Object.freeze(rule)));

interface Entry {
    id: string; purpose: string; subtype: string; size: number; received: number; next: number;
    startedAt: number; path: string; file: FileHandle | null; hash: Hash;
}

/** One local connection's private disk area; phone UploadStaging is independent and unchanged. */
export class LocalUploads {
    readonly directory: string;
    readonly #now: () => number;
    readonly #staged = new Map<string, Entry>();
    readonly #claimed = new Set<Entry>();
    #dir: string | null = null;
    #tail: Promise<unknown> = Promise.resolve();
    #closed = false;
    #disposal: Promise<void> | null = null;

    constructor(deps: { root: string; now?: () => number }) {
        if (!deps || typeof deps.root !== 'string' || deps.root.length === 0) throw new Error('local uploads need a host-owned root directory');
        this.directory = join(resolve(deps.root), randomUUID()); this.#now = deps.now ?? Date.now;
    }

    begin(input: unknown): Promise<LocalUploadInfo> {
        return this.#run(async () => {
            const v = input as { purpose?: unknown; subtype?: unknown; size?: unknown } | null;
            const rule = LOCAL_UPLOAD_RULES.find(r => r.purpose === v?.purpose && r.subtype === v?.subtype);
            if (!rule) throw new Error('unknown local upload purpose/subtype');
            if (typeof v?.size !== 'number' || !Number.isSafeInteger(v.size) || v.size < 0 || v.size > rule.maxBytes)
                throw new Error(`a local upload is 0 to ${rule.maxBytes} bytes`);
            if (this.#staged.size + this.#claimed.size >= MAX_LOCAL_UPLOADS) throw new Error(`only ${MAX_LOCAL_UPLOADS} local uploads at a time`);
            if (!this.#dir) {
                const dir = this.directory;
                await mkdir(dir, { mode: 0o700 });
                try { await restrictPrivateDirectories([dir]); this.#dir = dir; }
                catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
            }
            const id = randomUUID(), entry: Entry = { id, purpose: rule.purpose, subtype: rule.subtype, size: v.size, received: 0, next: 0, startedAt: this.#now(), path: join(this.#dir, id), file: null, hash: createHash('sha256') };
            this.#staged.set(id, entry);
            try { entry.file = await open(entry.path, 'wx+', 0o600); await restrictPrivateFile(entry.path); }
            catch (error) { await this.#release(entry); throw error; }
            return { id, size: entry.size };
        });
    }

    chunk(id: unknown, index: unknown, base64: unknown): Promise<{ received: number }> {
        return this.#run(async () => {
            const e = typeof id === 'string' ? this.#staged.get(id) : undefined;
            if (!e?.file) throw new Error('no such local upload on this connection');
            if (index !== e.next) throw new Error(`expected chunk ${e.next}`);
            if (typeof base64 !== 'string' || base64.length === 0 || base64.length > 4 * Math.ceil(LOCAL_UPLOAD_CHUNK_BYTES / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('a local upload chunk is bounded base64 text');
            const bytes = Buffer.from(base64, 'base64');
            if (bytes.length === 0 || bytes.length > LOCAL_UPLOAD_CHUNK_BYTES || bytes.toString('base64') !== base64) throw new Error(`a local chunk is 1 to ${LOCAL_UPLOAD_CHUNK_BYTES} bytes`);
            if (bytes.length > e.size - e.received) throw new Error('more bytes than the local upload declared');
            try {
                for (let at = 0; at < bytes.length;) {
                    const { bytesWritten } = await e.file.write(bytes, at, bytes.length - at, e.received + at);
                    if (bytesWritten <= 0) throw new Error('the local upload write made no progress');
                    at += bytesWritten;
                }
            } catch (error) { await this.#release(e); throw error; }
            e.hash.update(bytes); e.received += bytes.length; e.next++;
            return { received: e.received };
        });
    }

    abort(id: unknown): Promise<{ aborted: boolean }> {
        return this.#run(async () => {
            const e = typeof id === 'string' ? this.#staged.get(id) : undefined;
            if (!e) return { aborted: false };
            await this.#release(e); return { aborted: true };
        });
    }

    /** Not a wire method. The consuming host call names its own fixed expected target. */
    take(id: string, purpose: LocalUploadTarget['purpose'], subtype: string): Promise<LocalUploadSource | null> {
        return this.#run(async () => {
            const e = this.#staged.get(id);
            if (!e || e.purpose !== purpose || e.subtype !== subtype || e.received !== e.size) return null;
            this.#staged.delete(id); this.#claimed.add(e);
            return {
                size: e.size, sha256: e.hash.digest('hex'),
                read: (offset, length) => this.#run(async () => {
                    if (!this.#claimed.has(e) || !e.file) throw new Error('the local upload source is closed');
                    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > BLOB_READ_BYTES || offset > e.size || length > e.size - offset) throw new Error('the local upload read is outside its bounded size');
                    const bytes = Buffer.alloc(length);
                    for (let at = 0; at < length;) {
                        const { bytesRead } = await e.file.read(bytes, at, length - at, offset + at);
                        if (bytesRead <= 0) throw new Error('the local upload source ended before its declared size');
                        at += bytesRead;
                    }
                    return bytes;
                }),
                close: () => this.#closed ? this.dispose() : this.#queue(() => this.#release(e)),
            };
        });
    }

    dispose(): Promise<void> {
        this.#closed = true;
        return this.#disposal ??= this.#queue(async () => {
            const released = await Promise.allSettled([...this.#staged.values(), ...this.#claimed].map(e => this.#release(e)));
            if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
            if (released.some(r => r.status === 'rejected')) throw new Error('a local upload could not be released');
        });
    }

    #queue<T>(work: () => Promise<T>): Promise<T> {
        const result = this.#tail.then(work); this.#tail = result.catch(() => {}); return result;
    }
    #run<T>(work: () => Promise<T>): Promise<T> {
        return this.#queue(async () => {
            this.#assertOpen();
            for (const e of this.#staged.values()) if (this.#now() - e.startedAt > LOCAL_UPLOAD_TTL_MS) await this.#release(e);
            this.#assertOpen(); const result = await work(); this.#assertOpen(); return result;
        });
    }
    #assertOpen(): void { if (this.#closed) throw new Error('the local upload connection is closed'); }
    async #release(e: Entry): Promise<void> {
        this.#staged.delete(e.id); this.#claimed.delete(e);
        const file = e.file; e.file = null;
        try { await file?.close(); } finally { await rm(e.path, { force: true }); }
    }
}
