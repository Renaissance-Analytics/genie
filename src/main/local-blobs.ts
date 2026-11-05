import { randomUUID } from 'node:crypto';
import { BLOB_KINDS, BLOB_READ_BYTES, MAX_OPEN_BLOBS, type BlobInfo, type BlobKind, type BlobOpener, type BlobSource } from '../core/local-blobs.js';

interface Opened { source: BlobSource | null; size: number }

/** One admitted connection owns this registry, including reservations still opening. */
export class LocalBlobs {
    readonly #openSource: BlobOpener | undefined;
    readonly #opened = new Map<string, Opened>();
    #closed = false;

    constructor(openSource?: BlobOpener) { this.#openSource = openSource; }

    async open(kind: unknown, ref: unknown): Promise<BlobInfo> {
        if (this.#closed) throw new Error('this blob connection is closed');
        if (typeof kind !== 'string' || !(BLOB_KINDS as readonly string[]).includes(kind)) throw new Error('unknown local blob kind');
        if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref)) throw new Error('a blob needs a host-issued reference');
        if (this.#opened.size >= MAX_OPEN_BLOBS) throw new Error(`only ${MAX_OPEN_BLOBS} blobs may be open on this connection`);
        if (!this.#openSource) throw new Error('blob content is not available on this host yet');
        const id = randomUUID(), entry: Opened = { source: null, size: 0 };
        this.#opened.set(id, entry);
        let source: BlobSource | undefined;
        try {
            source = await this.#openSource(kind as BlobKind, ref);
            if (!source || !Number.isSafeInteger(source.size) || source.size < 0 || typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(source.sha256) || typeof source.read !== 'function' || typeof source.close !== 'function')
                throw new Error('the host returned invalid blob metadata');
            if (this.#closed || this.#opened.get(id) !== entry) throw new Error('the connection closed before its blob opened');
            entry.source = source; entry.size = source.size;
            return { id, size: entry.size, sha256: source.sha256 };
        } catch (error) {
            this.#opened.delete(id);
            if (source) await this.#quietClose(source);
            throw error;
        }
    }

    async read(id: unknown, offset: unknown, length: unknown): Promise<{ base64: string }> {
        const entry = typeof id === 'string' ? this.#opened.get(id) : undefined;
        if (this.#closed || !entry?.source) throw new Error('no such open blob on this connection');
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > BLOB_READ_BYTES || offset > entry.size || length > entry.size - offset)
            throw new Error(`a blob read must be within its size and at most ${BLOB_READ_BYTES} bytes`);
        if (length === 0) return { base64: '' };
        const bytes = await entry.source.read(offset, length);
        if (this.#closed || this.#opened.get(id as string) !== entry) throw new Error('the blob connection closed during its read');
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('the blob source did not return the requested bytes');
        return { base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') };
    }

    async close(id: unknown): Promise<{ closed: boolean }> {
        const entry = typeof id === 'string' ? this.#opened.get(id) : undefined;
        if (!entry?.source) return { closed: false };
        this.#opened.delete(id as string);
        await entry.source.close();
        return { closed: true };
    }

    dispose(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const entry of this.#opened.values()) if (entry.source) void this.#quietClose(entry.source);
        this.#opened.clear();
    }

    async #quietClose(source: BlobSource): Promise<void> {
        try { await source.close(); }
        catch { console.warn('[genie] a local blob source could not be released'); }
    }
}
