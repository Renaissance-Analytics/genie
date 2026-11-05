import { randomUUID } from 'node:crypto';
import { MAX_OPEN_PAGES, PAGE_KINDS, PAGE_MAX_BYTES, PAGE_MAX_ITEMS, type MetadataItem, type MetadataPage, type PageKind, type PageOpener, type PageSource } from '../core/local-content.js';

interface Pending { item: MetadataItem; bytes: number }
interface Opened { id: string; source: PageSource | null; pending: Pending | null; busy: boolean; released: boolean }
class OversizedRecord extends Error {}

/** A connection owns its source snapshots/cursors. One oversized record stays pending until closed. */
export class LocalPages {
    readonly #openSource: PageOpener | undefined;
    readonly #opened = new Map<string, Opened>();
    #closed = false;
    constructor(openSource?: PageOpener) { this.#openSource = openSource; }

    async open(kind: unknown, ref: unknown): Promise<MetadataPage> {
        if (this.#closed) throw new Error('the page connection is closed');
        if (typeof kind !== 'string' || !(PAGE_KINDS as readonly string[]).includes(kind)) throw new Error('unknown local list kind');
        if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref)) throw new Error('a list needs a host-issued reference');
        if (this.#opened.size >= MAX_OPEN_PAGES) throw new Error(`only ${MAX_OPEN_PAGES} lists may be open on this connection`);
        if (!this.#openSource) throw new Error('list metadata is not available on this host yet');
        const e: Opened = { id: randomUUID(), source: null, pending: null, busy: true, released: false };
        this.#opened.set(e.id, e);
        try {
            e.source = await this.#openSource(kind as PageKind, ref);
            if (!e.source || typeof e.source.next !== 'function' || typeof e.source.close !== 'function') throw new Error('the host returned an invalid list source');
            this.#assertLive(e); return await this.#page(e);
        } catch (error) { await this.#release(e); throw error; }
        finally { e.busy = false; }
    }

    async next(cursor: unknown): Promise<MetadataPage> {
        const e = typeof cursor === 'string' ? this.#opened.get(cursor) : undefined;
        if (!e?.source) throw new Error('no such list cursor on this connection');
        this.#assertLive(e);
        if (e.busy) throw new Error('this list cursor is already reading a page');
        e.busy = true;
        try { return await this.#page(e); }
        catch (error) { if (!(error instanceof OversizedRecord)) await this.#release(e); throw error; }
        finally { e.busy = false; }
    }

    async close(cursor: unknown): Promise<{ closed: boolean }> {
        const e = typeof cursor === 'string' ? this.#opened.get(cursor) : undefined;
        if (!e) return { closed: false };
        await this.#release(e); return { closed: true };
    }

    dispose(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const e of this.#opened.values()) void this.#release(e);
        this.#opened.clear();
    }

    async #page(e: Opened): Promise<MetadataPage> {
        const items: MetadataItem[] = [];
        let bytes = Buffer.byteLength(JSON.stringify({ items: [], cursor: e.id }));
        while (true) {
            if (!e.pending) {
                const value = await e.source!.next(); this.#assertLive(e);
                if (value === null) { await this.#release(e); return { items, cursor: null }; }
                if (typeof value !== 'object' || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) throw new Error('the host returned invalid list metadata');
                const serialized = JSON.stringify(value);
                e.pending = { item: JSON.parse(serialized) as MetadataItem, bytes: Buffer.byteLength(serialized) };
            }
            const pending = e.pending;
            if (items.length >= PAGE_MAX_ITEMS) return { items, cursor: e.id };
            const extra = pending.bytes + (items.length ? 1 : 0);
            if (bytes + extra > PAGE_MAX_BYTES) {
                if (items.length) return { items, cursor: e.id };
                throw new OversizedRecord(`metadata record ${pending.item.id} is ${pending.bytes} bytes; page limit is ${PAGE_MAX_BYTES}`);
            }
            items.push(pending.item); bytes += extra; e.pending = null;
        }
    }
    #assertLive(e: Opened): void {
        if (this.#closed || this.#opened.get(e.id) !== e) throw new Error('the list connection closed during its page read');
    }
    async #release(e: Opened): Promise<void> {
        this.#opened.delete(e.id); e.pending = null;
        if (e.released || !e.source) return;
        e.released = true;
        try { await e.source.close(); } catch { console.warn('[genie] a local list source could not be released'); }
    }
}
