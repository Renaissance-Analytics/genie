import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PluginsService } from './plugins-host.js';
import type { SessionFetch } from './tynn-account.js';

export const MARKETPLACE_PAGE_BYTES = 512 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
const MAX_KEYS = 10_000;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type PublisherKeyState = 'trusted' | 'withdrawn' | 'unknown';
export interface PublisherKeyRegistry {
    publisherKeys(bundled?: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
    keyState(id: string): PublisherKeyState;
    refresh(): Promise<void>;
}

interface RegistryResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly headers?: { get(name: string): string | null };
    readonly body?: ReadableStream<Uint8Array> | null;
    text(): Promise<string>;
}
type RegistryFetch = (url: string, init: Parameters<SessionFetch>[1]) => Promise<RegistryResponse>;
export interface MarketplaceClientOptions {
    readonly cacheFile: string;
    /** Production supplies hostHttpsFetch: OS trust/proxies, explicit TLS verification and a streaming body cap. */
    readonly fetch: RegistryFetch;
    readonly origin?: string;
    readonly now?: () => number;
    readonly maxCacheAgeMs?: number;
    readonly timeoutMs?: number;
}
interface PublisherKey {
    readonly key_id: string;
    readonly public_key_pem: string;
    readonly publisher: { readonly id: string; readonly name: string; readonly verification: { readonly method: 'domain' | 'github_org'; readonly identity: string } };
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positive(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid marketplace ${label}`);
    return value;
}
function registryOrigin(value: string): string {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The publisher registry must be an HTTPS origin');
    return url.origin;
}
function publisherKey(value: unknown): PublisherKey {
    const invalid = (): never => { throw new Error('Invalid publisher registry key or public publisher identity'); };
    if (!record(value) || typeof value.key_id !== 'string' || !KEY_ID.test(value.key_id) || typeof value.public_key_pem !== 'string' || value.public_key_pem.length > 4096) return invalid();
    const match = /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PUBLIC KEY-----$/.exec(value.public_key_pem.trim());
    if (!match) return invalid();
    const encoded = match[1]!.replace(/\s/g, '');
    const der = Buffer.from(encoded, 'base64');
    if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX) || der.toString('base64') !== encoded || `sha256:${createHash('sha256').update(der).digest('hex')}` !== value.key_id) return invalid();
    const publisher = value.publisher;
    if (!record(publisher) || typeof publisher.id !== 'string' || !ULID.test(publisher.id) || typeof publisher.name !== 'string' || !publisher.name.trim() || [...publisher.name].length > 100 || !record(publisher.verification)) return invalid();
    const { method, identity } = publisher.verification;
    if (typeof identity !== 'string') return invalid();
    if (method === 'domain') {
        if (identity.length > 237 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(identity)) return invalid();
    } else if (method === 'github_org') {
        if (!/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(identity)) return invalid();
    } else return invalid();
    // Retain only the C1 public contract. A response cannot grant an official flag or arbitrary local metadata.
    return { key_id: value.key_id, public_key_pem: `-----BEGIN PUBLIC KEY-----\n${encoded}\n-----END PUBLIC KEY-----\n`, publisher: { id: publisher.id, name: publisher.name, verification: { method, identity } } };
}
function keyRows(value: unknown, limit: number): Map<string, PublisherKey> {
    if (!Array.isArray(value) || value.length > limit) throw new Error('Publisher registry key count exceeds its limit');
    const rows = new Map<string, PublisherKey>();
    for (const raw of value) {
        const row = publisherKey(raw);
        if (rows.has(row.key_id)) throw new Error('Duplicate publisher registry key');
        rows.set(row.key_id, row);
    }
    return rows;
}
function aborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? new Error('Publisher registry request aborted');
}
async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void promise.catch(() => {}); aborted(signal); }
    let cancel!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason ?? new Error('Publisher registry request aborted'));
        signal.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([promise, stopped]); }
    finally { signal.removeEventListener('abort', cancel); }
}
async function responseText(response: RegistryResponse, signal: AbortSignal): Promise<string> {
    const length = response.headers?.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MARKETPLACE_PAGE_BYTES)) throw new Error('Publisher registry response exceeds the size limit');
    if (!response.body) {
        // The production HTTPS adapter bounds bytes BEFORE buffering, even without a Content-Length.
        const text = await untilAbort(response.text(), signal);
        if (Buffer.byteLength(text) > MARKETPLACE_PAGE_BYTES) throw new Error('Publisher registry response exceeds the size limit');
        return text;
    }
    const reader = response.body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            aborted(signal);
            const part = await untilAbort(reader.read(), signal);
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > MARKETPLACE_PAGE_BYTES) { cancel(); throw new Error('Publisher registry response exceeds the size limit'); }
            chunks.push(part.value);
        }
        aborted(signal);
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Anonymous REST trust data, never an MCP call. Only a COMPLETE valid snapshot may grant or withdraw keys. */
export class MarketplaceClient implements PublisherKeyRegistry {
    readonly #options: MarketplaceClientOptions;
    readonly #origin: string;
    readonly #now: () => number;
    readonly #age: number;
    readonly #timeout: number;
    #rows = new Map<string, PublisherKey>();
    #withdrawn = new Set<string>();
    #fetchedAt: number | null = null;
    #refreshing: Promise<void> | null = null;
    #controller: AbortController | null = null;
    #closed = false;

    private constructor(options: MarketplaceClientOptions) {
        this.#options = options;
        this.#origin = registryOrigin(options.origin ?? 'https://tynn.ai');
        this.#now = options.now ?? Date.now;
        this.#age = positive(options.maxCacheAgeMs ?? 30 * 60_000, 'cache age');
        this.#timeout = positive(options.timeoutMs ?? 10_000, 'request deadline');
    }

    static async open(options: MarketplaceClientOptions): Promise<MarketplaceClient> {
        const client = new MarketplaceClient(options);
        await client.#readCache();
        return client;
    }

    #fresh(): boolean {
        const now = this.#now();
        return this.#fetchedAt !== null && now >= this.#fetchedAt && now - this.#fetchedAt < this.#age;
    }
    publisherKeys(bundled: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
        return Object.freeze({ ...(this.#fresh() ? Object.fromEntries([...this.#rows].map(([id, row]) => [id, row.public_key_pem])) : {}), ...bundled });
    }
    keyState(id: string): PublisherKeyState {
        if (this.#withdrawn.has(id)) return 'withdrawn';
        return this.#fresh() && this.#rows.has(id) ? 'trusted' : 'unknown';
    }
    refresh(): Promise<void> {
        if (this.#closed) return Promise.reject(new Error('Publisher registry client is closed'));
        if (this.#refreshing) return this.#refreshing;
        this.#refreshing = this.#refresh().finally(() => { this.#refreshing = null; });
        return this.#refreshing;
    }
    close(): void {
        this.#closed = true;
        this.#controller?.abort(new Error('Publisher registry refresh aborted at shutdown'));
    }

    async #refresh(): Promise<void> {
        const controller = new AbortController();
        this.#controller = controller;
        const deadline = setTimeout(() => controller.abort(new Error('Publisher registry refresh timed out')), this.#timeout);
        try {
            const rows = new Map<string, PublisherKey>();
            const cursors = new Set<string>();
            let cursor: string | null = null;
            for (let page = 0; ; page++) {
                if (page >= 50) throw new Error('Publisher registry page limit exceeded');
                aborted(controller.signal);
                const url = `${this.#origin}/api/v1/marketplace/publisher-keys${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
                const response = await untilAbort(this.#options.fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal }), controller.signal);
                if (!response.ok || response.status !== 200) throw new Error(`Publisher registry answered ${response.status}`);
                const data: unknown = JSON.parse(await responseText(response, controller.signal));
                if (!record(data) || !('next_cursor' in data) || (data.next_cursor !== null && (typeof data.next_cursor !== 'string' || !ULID.test(data.next_cursor)))) throw new Error('Invalid publisher registry page or cursor');
                for (const [id, row] of keyRows(data.keys, 200)) {
                    if (rows.has(id)) throw new Error('Duplicate publisher registry key across pages');
                    rows.set(id, row);
                }
                if (rows.size > MAX_KEYS) throw new Error('Publisher registry key limit exceeded');
                cursor = data.next_cursor as string | null;
                if (cursor === null) break;
                if (cursors.has(cursor)) throw new Error('Publisher registry cursor loop');
                cursors.add(cursor);
            }
            aborted(controller.signal);
            await this.#commit(rows);
        } finally { clearTimeout(deadline); this.#controller = null; }
    }

    async #readCache(): Promise<void> {
        try {
            if (!(await lstat(this.#options.cacheFile)).isFile()) return;
            const file = await open(this.#options.cacheFile, 'r');
            let text: string;
            try {
                const chunks: Buffer[] = [];
                let bytes = 0;
                for (;;) {
                    const chunk = Buffer.alloc(64 * 1024);
                    const { bytesRead } = await file.read(chunk);
                    if (!bytesRead) break;
                    bytes += bytesRead;
                    if (bytes > CACHE_BYTES) throw new Error('Publisher registry cache exceeds its size limit');
                    chunks.push(chunk.subarray(0, bytesRead));
                }
                text = Buffer.concat(chunks).toString('utf8');
            } finally { await file.close(); }
            const data: unknown = JSON.parse(text);
            if (!record(data) || data.version !== 1 || data.origin !== this.#origin || typeof data.fetched_at !== 'number' || !Number.isFinite(data.fetched_at) || data.fetched_at < 0 || data.fetched_at > this.#now() || !Array.isArray(data.withdrawn) || !data.withdrawn.every((id: unknown) => typeof id === 'string' && KEY_ID.test(id))) return;
            const rows = keyRows(data.keys, MAX_KEYS);
            const withdrawn = new Set<string>(data.withdrawn);
            if ([...rows.keys()].some(id => withdrawn.has(id))) return;
            this.#rows = rows;
            this.#withdrawn = withdrawn;
            this.#fetchedAt = data.fetched_at;
        } catch { /* Absent or invalid cache grants nothing. Network refresh is separate and cannot block startup. */ }
    }

    async #commit(rows: Map<string, PublisherKey>): Promise<void> {
        const withdrawn = new Set(this.#withdrawn);
        let reduced = false;
        for (const id of this.#rows.keys()) if (!rows.has(id)) { withdrawn.add(id); reduced = true; }
        // Security reductions take effect even if disk is full. A storage failure may not retain KNOWN withdrawn authority.
        this.#rows = new Map([...this.#rows].filter(([id]) => rows.has(id)));
        this.#withdrawn = withdrawn;
        const nextWithdrawn = [...withdrawn].filter(id => !rows.has(id));
        const fetchedAt = this.#now();
        const text = JSON.stringify({ version: 1, origin: this.#origin, fetched_at: fetchedAt, keys: [...rows.values()], withdrawn: nextWithdrawn });
        const tmp = `${this.#options.cacheFile}.${randomUUID()}.tmp`;
        try {
            if (Buffer.byteLength(text) > CACHE_BYTES) throw new Error('Publisher registry cache exceeds its size limit');
            await mkdir(dirname(this.#options.cacheFile), { recursive: true });
            await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await rename(tmp, this.#options.cacheFile);
        } catch (error) {
            // Best effort: an old on-disk snapshot must not resurrect a removed key after restart.
            if (reduced) await rm(this.#options.cacheFile, { force: true }).catch(() => {});
            throw error;
        } finally { await rm(tmp, { force: true }).catch(() => {}); }
        this.#rows = rows;
        this.#withdrawn = new Set(nextWithdrawn);
        this.#fetchedAt = fetchedAt;
    }
}

export interface MarketplacePluginsOptions extends MarketplaceClientOptions {
    readonly pluginsDir: string;
    readonly keys: Readonly<Record<string, string>>;
    readonly publisherChecksOff: () => boolean;
    readonly intervalMs?: number;
    readonly schedule?: (fn: () => void, ms: number) => () => void;
    readonly log?: (line: string) => void;
}

/** Open from disk, then refresh without holding up a windowless host. The host owns and stops this one clock. */
export async function openMarketplacePlugins(options: MarketplacePluginsOptions): Promise<{ plugins: PluginsService; stop(): void }> {
    const interval = positive(options.intervalMs ?? 5 * 60_000, 'refresh interval');
    const registry = await MarketplaceClient.open(options);
    let plugins: PluginsService;
    try { plugins = await PluginsService.open({ dir: options.pluginsDir, keys: options.keys, publisherChecksOff: options.publisherChecksOff, registry }); }
    catch (error) { registry.close(); throw error; }
    const schedule = options.schedule ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); });
    let stopped = false;
    let cancel: (() => void) | null = null;
    const refresh = async (): Promise<void> => {
        try { await plugins.call('refresh', []); }
        catch (error) { if (!stopped) options.log?.(`Publisher registry refresh failed: ${error instanceof Error ? error.message : String(error)}`); }
        finally { if (!stopped) cancel = schedule(() => { cancel = null; void refresh(); }, interval); }
    };
    void refresh();
    return { plugins, stop: () => { stopped = true; cancel?.(); cancel = null; registry.close(); } };
}
