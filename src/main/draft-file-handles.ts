import { randomUUID } from 'node:crypto';
import { isDraftRef } from '../core/chat-drafts.js';
import { BLOB_READ_BYTES, MAX_OPEN_BLOBS, type BlobSource } from '../core/local-blobs.js';
import { LOCAL_UPLOAD_TTL_MS } from '../core/local-content.js';

interface Entry { handle: string; source: BlobSource | null; controller: AbortController; timer: ReturnType<typeof setTimeout> | null }
/** One authenticated engine connection's host files, including reservations still hashing. */
export class DraftFileHandles {
    readonly #open: (ref: string, options: { signal: AbortSignal }) => Promise<BlobSource | null>;
    readonly #idleMs: number;
    readonly #entries = new Map<string, Entry>();
    #closed = false;
    constructor(open: (ref: string, options: { signal: AbortSignal }) => Promise<BlobSource | null>, idleMs = LOCAL_UPLOAD_TTL_MS) {
        this.#open = open; this.#idleMs = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : LOCAL_UPLOAD_TTL_MS;
    }
    async open(ref: unknown): Promise<{ handle: string; size: number; sha256: string } | null> {
        if (this.#closed) throw new Error('the engine draft file connection is closed');
        if (!isDraftRef(ref)) throw new Error('a draft file needs a host-minted UUID ref');
        if (this.#entries.size >= MAX_OPEN_BLOBS) throw new Error(`only ${MAX_OPEN_BLOBS} draft file handles may be open on this engine connection`);
        const entry: Entry = { handle: randomUUID(), source: null, controller: new AbortController(), timer: null }; this.#entries.set(entry.handle, entry); this.#touch(entry, LOCAL_UPLOAD_TTL_MS);
        try {
            const source = await this.#open(ref, { signal: entry.controller.signal });
            if (!source) { await this.#release(entry); return null; }
            if (this.#closed || this.#entries.get(entry.handle) !== entry) { await source.close(); throw new Error('the engine connection closed while its draft file opened'); }
            entry.source = source; this.#touch(entry); return { handle: entry.handle, size: source.size, sha256: source.sha256 };
        } catch (error) { await this.#release(entry); throw error; }
    }
    async read(handle: unknown, offset: unknown, length: unknown): Promise<{ base64: string }> {
        const entry = this.#entry(handle), source = entry.source;
        if (!source) throw new Error('the draft file handle is still opening');
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > BLOB_READ_BYTES || offset > source.size || length > source.size - offset) throw new Error(`a draft file range is within its size and at most ${BLOB_READ_BYTES} bytes`);
        this.#touch(entry); const bytes = await source.read(offset, length);
        if (this.#closed || this.#entries.get(entry.handle) !== entry) throw new Error('the engine draft handle closed during its read');
        if (bytes.byteLength !== length) throw new Error('the draft source omitted bytes');
        return { base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') };
    }
    async close(handle: unknown): Promise<{ closed: true }> { await this.#release(this.#entry(handle)); return { closed: true }; }
    async dispose(): Promise<void> {
        if (this.#closed) return; this.#closed = true;
        await Promise.all([...this.#entries.values()].map(entry => this.#release(entry).catch(() => { console.warn('[genie] a disconnected draft handle could not be closed'); })));
    }
    #entry(handle: unknown): Entry {
        const entry = typeof handle === 'string' ? this.#entries.get(handle) : undefined;
        if (this.#closed || !entry) throw new Error('no such draft file handle on this engine connection'); return entry;
    }
    #touch(entry: Entry, delay = this.#idleMs): void {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { void this.#release(entry).catch(() => { console.warn('[genie] an expired draft handle could not be closed'); }); }, delay); entry.timer.unref?.();
    }
    async #release(entry: Entry): Promise<void> {
        if (this.#entries.get(entry.handle) === entry) this.#entries.delete(entry.handle);
        if (entry.timer) clearTimeout(entry.timer); entry.timer = null; entry.controller.abort();
        const source = entry.source; entry.source = null; if (source) await source.close();
    }
}
