import { createHash, randomUUID } from 'node:crypto';
import type { BlobKind, BlobOpener, BlobSource } from '../core/local-blobs.js';
import { LOCAL_UPLOAD_TTL_MS, type MetadataItem, type PageKind, type PageOpener, type PageSource } from '../core/local-content.js';
import { FILES_INLINE_BYTES, type FilesContentEnvelope, type FilesPageKind, type FilesProjection } from '../core/local-files.js';
import { validateDraftRanges, type DraftContentEnvelope, type DraftMetadata, type LocalDraftMethod } from '../core/local-drafts.js';
import { LocalBlobs } from './local-blobs.js';
import { LocalPageBudget, LocalPages } from './local-pages.js';

interface Scope { ref: string; expires: number; timer: ReturnType<typeof setTimeout>; releaseBudget: () => void; refs: Set<string>; sources: Set<BlobSource> }
type Resource = { scope: Scope } & ({ type: 'blob'; kind: BlobKind; bytes: Buffer | null; sha256: string } | { type: 'page'; kind: FilesPageKind; value: readonly unknown[] | Record<string, unknown>; object: boolean; projected: boolean; cache?: Map<number, MetadataItem> } | { type: 'draft-page'; items: readonly DraftMetadata[] });

/** One connection's workspace/draft snapshots. Shared budget and expiry, including forgotten finally/release. */
export class LocalFilesContent {
    readonly blobs: LocalBlobs;
    readonly pages: LocalPages;
    readonly #budget = new LocalPageBudget();
    readonly #scopes = new Map<string, Scope>();
    readonly #refs = new Map<string, Resource>();
    readonly #now: () => number;
    #closed = false;
    constructor(deps: { now?: () => number; openBlob?: BlobOpener; openPage?: PageOpener } = {}) {
        this.#now = deps.now ?? Date.now;
        this.blobs = new LocalBlobs(async (kind, ref) => this.#refs.has(ref) ? this.#blob(kind, ref) : deps.openBlob ? deps.openBlob(kind, ref) : Promise.reject(new Error('no such workspace content ref on this connection')));
        this.pages = new LocalPages(async (kind, ref) => this.#refs.has(ref) ? this.#page(kind, ref) : deps.openPage ? deps.openPage(kind, ref) : Promise.reject(new Error('no such workspace metadata ref on this connection')), this.#budget, ref => this.#refs.get(ref)?.scope.ref);
    }
    begin(): string {
        this.#assertOpen(); this.#expire();
        const ref = randomUUID(), releaseBudget = this.#budget.hold(ref);
        const timer = setTimeout(() => this.release(ref), LOCAL_UPLOAD_TTL_MS); timer.unref?.();
        this.#scopes.set(ref, { ref, releaseBudget, timer, expires: this.#now() + LOCAL_UPLOAD_TTL_MS, refs: new Set(), sources: new Set() });
        return ref;
    }
    capture(value: unknown, kind: FilesPageKind, bytes = false): unknown {
        const ref = this.begin();
        try { return this.result(ref, value, kind, bytes); } catch (error) { this.release(ref); throw error; }
    }
    result(ref: string, value: unknown, kind: FilesPageKind, bytes = false): unknown {
        const scope = this.#scope(ref), projected = this.#project(scope, value, kind, bytes);
        if (scope.refs.size === 0) { this.release(ref); return value; }
        return { filesContent: { ref, value: projected } } satisfies FilesContentEnvelope;
    }
    draftResult(ref: string, method: LocalDraftMethod, value: unknown): unknown {
        const scope = this.#scope(ref);
        if (value === null) { this.release(ref); return null; }
        if (method === 'chatDrafts.readFile') {
            if (!(value instanceof Uint8Array)) throw new Error('invalid kept draft file bytes');
            const bytes = Buffer.from(value), blob = this.#resource(scope, { scope, type: 'blob', kind: 'draft-file', bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
            return { draftsContent: { ref, blob } } satisfies DraftContentEnvelope;
        }
        if (method !== 'chatDrafts.load' || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid kept draft list');
        const entries = Object.entries(value);
        if (!entries.length) { this.release(ref); return value; }
        const resource: Resource = { scope, type: 'blob', kind: 'draft-file', bytes: null, sha256: '' }, blob = this.#resource(scope, resource);
        const chunks: Buffer[] = [], items: DraftMetadata[] = []; let length = 0;
        for (const [name, draft] of entries) {
            const bytes = Buffer.from(JSON.stringify(draft));
            items.push({ id: String(items.length), name, size: bytes.length, type: 'application/json', sha256: createHash('sha256').update(bytes).digest('hex'), ref: blob, offset: length, length: bytes.length });
            chunks.push(bytes); length += bytes.length;
        }
        validateDraftRanges(items, length);
        resource.bytes = Buffer.concat(chunks, length); resource.sha256 = createHash('sha256').update(resource.bytes).digest('hex');
        const list = this.#resource(scope, { scope, type: 'draft-page', items });
        return { draftsContent: { ref, blob, list, count: items.length } } satisfies DraftContentEnvelope;
    }
    release(ref: unknown): { released: boolean } {
        const scope = typeof ref === 'string' ? this.#scopes.get(ref) : undefined;
        if (!scope) return { released: false };
        this.#scopes.delete(scope.ref); clearTimeout(scope.timer);
        this.pages.releaseResource(scope.ref); this.blobs.releaseSources(scope.sources);
        for (const id of scope.refs) { const resource = this.#refs.get(id); if (resource?.type === 'blob') resource.bytes = null; this.#refs.delete(id); }
        scope.refs.clear(); scope.sources.clear(); scope.releaseBudget();
        return { released: true };
    }
    dispose(): void {
        if (this.#closed) return; this.#closed = true;
        for (const ref of this.#scopes.keys()) this.release(ref);
        this.blobs.dispose(); this.pages.dispose();
    }
    #assertOpen(): void { if (this.#closed) throw new Error('this content connection is closed'); }
    #expire(): void { for (const scope of this.#scopes.values()) if (scope.expires <= this.#now()) this.release(scope.ref); }
    #scope(ref: string): Scope {
        this.#assertOpen(); this.#expire();
        const scope = this.#scopes.get(ref); if (!scope) throw new Error('the content ref was released or expired on this connection'); return scope;
    }
    #resource(scope: Scope, value: Resource): string {
        this.#scope(scope.ref); const ref = randomUUID(); scope.refs.add(ref); this.#refs.set(ref, value); return ref;
    }
    #project(scope: Scope, value: unknown, kind: FilesPageKind, bytes: boolean, key?: string): FilesProjection {
        if (value === undefined) return { t: 'undefined' };
        if (typeof value === 'string') {
            if (Buffer.byteLength(JSON.stringify(value)) <= FILES_INLINE_BYTES) return { t: 'value', value };
            const buffer = Buffer.from(value, bytes && key === 'base64' ? 'base64' : 'utf8');
            const ref = this.#resource(scope, { scope, type: 'blob', kind: 'workspace-file', bytes: buffer, sha256: createHash('sha256').update(buffer).digest('hex') });
            return { t: 'blob', ref, encoding: bytes && key === 'base64' ? 'base64' : 'utf8' };
        }
        if (value === null || typeof value === 'number' || typeof value === 'boolean') return { t: 'value', value };
        if (Array.isArray(value)) return value.length === 0 ? { t: 'json', value } : { t: 'array', kind, count: value.length, ref: this.#resource(scope, { scope, type: 'page', kind, value, object: false, projected: false }) };
        if (typeof value !== 'object') throw new Error('invalid workspace response value');
        const object = value as Record<string, unknown>, keys = Object.keys(object);
        // Bound a plain leaf once, rather than serializing every scalar/key and wrapping each field.
        // Undefined/large/nested values retain the lossless projection below.
        const prototype = Object.getPrototypeOf(object);
        if ((prototype === Object.prototype || prototype === null) && keys.every(k => {
            const item = object[k];
            return item === null || typeof item === 'number' || typeof item === 'boolean' || (typeof item === 'string' && item.length <= FILES_INLINE_BYTES) || (Array.isArray(item) && item.length === 0);
        }) && Buffer.byteLength(JSON.stringify(object)) <= FILES_INLINE_BYTES) return { t: 'json', value: object };
        // Long object keys travel as values on a metadata page too; never put them directly into a frame.
        if (keys.some(k => Buffer.byteLength(JSON.stringify(k)) > FILES_INLINE_BYTES)) return { t: 'object', kind, count: keys.length, ref: this.#resource(scope, { scope, type: 'page', kind, value: object, object: true, projected: false }) };
        const entries = keys.map(k => [k, this.#project(scope, object[k], kind, bytes, k)] as [string, FilesProjection]);
        const projected: FilesProjection = { t: 'record', entries };
        if (Buffer.byteLength(JSON.stringify(projected)) <= FILES_INLINE_BYTES) return projected;
        // Avoid retaining duplicate lazy refs from a speculative inline projection: the page reuses these projections.
        return { t: 'object', kind, count: keys.length, ref: this.#resource(scope, { scope, type: 'page', kind, value: Object.fromEntries(entries), object: true, projected: true }) };
    }
    #blob(kind: BlobKind, ref: string): BlobSource {
        const resource = this.#refs.get(ref);
        if (resource?.type !== 'blob' || kind !== resource.kind) throw new Error('no such workspace content ref');
        const scope = this.#scope(resource.scope.ref); let closed = false;
        const source: BlobSource = {
            size: resource.bytes!.length, sha256: resource.sha256,
            read: async (offset, length) => { this.#scope(scope.ref); if (closed || !resource.bytes) throw new Error('the workspace content source is closed'); return resource.bytes.subarray(offset, offset + length); },
            close: async () => { closed = true; scope.sources.delete(source); },
        };
        scope.sources.add(source); return source;
    }
    #page(kind: PageKind, ref: string): PageSource {
        const resource = this.#refs.get(ref);
        if (resource?.type === 'draft-page' && kind === 'chat-drafts') {
            const scope = this.#scope(resource.scope.ref); let index = 0, closed = false;
            return {
                next: async () => { this.#scope(scope.ref); if (closed) throw new Error('this draft metadata source is closed'); return resource.items[index++] ?? null; },
                close: async () => { closed = true; },
            };
        }
        if (resource?.type !== 'page' || resource.kind !== kind) throw new Error('no such workspace metadata ref');
        this.#scope(resource.scope.ref); let index = 0, closed = false;
        const entries = resource.object ? Object.entries(resource.value) : null;
        const cache = resource.cache ??= new Map<number, MetadataItem>();
        return {
            next: async (): Promise<MetadataItem | null> => {
                this.#scope(resource.scope.ref); if (closed) throw new Error('this workspace metadata source is closed');
                const cached = cache.get(index); if (cached) { index++; return cached; }
                if (entries) {
                    const pair = entries[index]; if (!pair) return null;
                    // Object pages may hold already-projected values after the inline byte-budget decision.
                    const value = pair[1], projected = resource.projected ? value as FilesProjection : this.#project(resource.scope, value, resource.kind, false);
                    const item = { id: String(index), key: this.#project(resource.scope, pair[0], resource.kind, false), value: projected };
                    cache.set(index++, item); return item;
                }
                const array = resource.value as readonly unknown[];
                if (index >= array.length) return null;
                const item = { id: String(index), value: this.#project(resource.scope, array[index], resource.kind, false) };
                cache.set(index++, item); return item;
            },
            close: async () => { closed = true; },
        };
    }
}
