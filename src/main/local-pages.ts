import { randomUUID } from 'node:crypto';
import { MAX_OPEN_PAGES, PAGE_KINDS, PAGE_MAX_BYTES, PAGE_MAX_ITEMS, type MetadataItem, type MetadataPage, type PageKind, type PageOpener, type PageSource } from '../core/local-content.js';

interface Pending { item: MetadataItem; bytes: number }
interface Opened { id: string; resource: string; releaseBudget: () => void; source: PageSource | null; pending: Pending | null; busy: boolean; released: boolean }
class OversizedRecord extends Error {}

/**
 * A response and cursors over that same snapshot share a slot; other lists retain their own reservation. A full budget
 * names what holds it (Tynn #547): nothing is evicted, since a held response may still be mid-read in the window.
 */
export class LocalPageBudget {
    readonly #held = new Map<string, { count: number; label: string; since: number }>();
    readonly #now: () => number;
    constructor(now: () => number = Date.now) { this.#now = now; }
    hold(key: string = randomUUID(), label = 'a list'): () => void {
        const entry = this.#held.get(key);
        if (!entry && this.#held.size >= MAX_OPEN_PAGES) throw new Error(`only ${MAX_OPEN_PAGES} lists or responses may be held on this connection; held by ${this.holders()}`);
        if (entry) entry.count++; else this.#held.set(key, { count: 1, label, since: this.#now() });
        let held = true;
        return () => { if (!held) return; held = false; const e = this.#held.get(key); if (!e) return; if (e.count <= 1) this.#held.delete(key); else e.count--; };
    }
    /** What holds the slots, by label, oldest first: `files.localOpen ×3 (oldest 4s)`. */
    holders(): string {
        const now = this.#now(), groups = new Map<string, { n: number; oldest: number }>();
        for (const { label, since } of this.#held.values()) { const g = groups.get(label); if (g) { g.n++; g.oldest = Math.min(g.oldest, since); } else groups.set(label, { n: 1, oldest: since }); }
        return [...groups].sort((a, b) => a[1].oldest - b[1].oldest).map(([label, g]) => `${label}${g.n > 1 ? ` ×${g.n}` : ''} (oldest ${Math.max(0, Math.round((now - g.oldest) / 1000))}s)`).join(', ') || 'nothing';
    }
}

/** A connection owns its source snapshots/cursors. One oversized record stays pending until closed. */
export class LocalPages {
    readonly #openSource: PageOpener | undefined;
    readonly #opened = new Map<string, Opened>();
    readonly #budget: LocalPageBudget;
    readonly #resourceOf: ((ref: string) => string | undefined) | undefined;
    #closed = false;
    constructor(openSource?: PageOpener, budget = new LocalPageBudget(), resourceOf?: (ref: string) => string | undefined) { this.#openSource = openSource; this.#budget = budget; this.#resourceOf = resourceOf; }

    async open(kind: unknown, ref: unknown): Promise<MetadataPage> {
        if (this.#closed) throw new Error('the page connection is closed');
        if (typeof kind !== 'string' || !(PAGE_KINDS as readonly string[]).includes(kind)) throw new Error('unknown local list kind');
        if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref)) throw new Error('a list needs a host-issued reference');
        if (this.#opened.size >= MAX_OPEN_PAGES) throw new Error(`only ${MAX_OPEN_PAGES} lists may be open on this connection`);
        if (!this.#openSource) throw new Error('list metadata is not available on this host yet');
        const resource = this.#resourceOf?.(ref) ?? randomUUID(), releaseBudget = this.#budget.hold(resource, `list ${kind}`);
        const e: Opened = { id: randomUUID(), resource, releaseBudget, source: null, pending: null, busy: true, released: false };
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

    releaseResource(resource: string): void {
        for (const entry of this.#opened.values()) if (entry.resource === resource) void this.#release(entry);
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
        e.releaseBudget();
        if (e.released || !e.source) return;
        e.released = true;
        try { await e.source.close(); } catch { console.warn('[genie] a local list source could not be released'); }
    }
}
