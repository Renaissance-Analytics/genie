import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compareMarketplaceVersions, needsMarketplaceConsent, type MarketplaceApi, type MarketplacePackage, type MarketplaceReview, type MarketplaceRow, type MarketplaceVersion } from '../core/marketplace.js';
import { parseManifest, type PluginCapabilities, type PluginManifest } from '../core/plugins.js';
import { extractMarketplaceArchive, MARKETPLACE_ARCHIVE_BYTES } from './marketplace-archive.js';
import { MARKETPLACE_PAGE_BYTES, type MarketplaceClient } from './marketplace-client.js';
import { checkPackage, currentDigest } from './plugin-package.js';
import type { PluginsService } from './plugins-host.js';
import type { HostHttpsResponse } from './host-https-fetch.js';
import type { SessionFetch } from './tynn-account.js';

type MarketplaceFetch = (url: string, init: Parameters<SessionFetch>[1]) => Promise<Pick<HostHttpsResponse, 'ok' | 'status' | 'text'> & Partial<Pick<HostHttpsResponse, 'headers'>> & { readonly body?: ReadableStream<Uint8Array> | null }>;
export interface MarketplaceHostOptions {
    readonly pluginsDir: string;
    readonly stagingDir: string;
    readonly grantsFile: string;
    readonly registry: MarketplaceClient;
    readonly plugins: PluginsService;
    /** Binary-capable HTTPS transport; never renderer fetch, credentials or an MCP endpoint. */
    readonly fetch: MarketplaceFetch;
    readonly origin?: string;
    readonly now?: () => number;
    readonly reviewMaxAgeMs?: number;
    readonly maxArchiveBytes?: number;
    readonly timeoutMs?: number;
    readonly log?: (line: string) => void;
}
interface Grant { id: string; version: string; digest: string; keyId: string; publisherId: string; capabilities: PluginCapabilities }
interface Baseline { folder: string | null; version: string | null; digest: string | null; capabilities: PluginCapabilities | null }
interface Staged { review: MarketplaceReview; dir: string; baseline: Baseline; expires: number }
const ID = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const KEY = /^sha256:[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BOOK_BYTES = 16 * 1024 * 1024;
const JOURNAL_BYTES = BOOK_BYTES + 4096;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (what: string): never => { throw new Error(`Invalid Marketplace ${what}`); };
const idOf = (value: unknown): string => typeof value === 'string' && value.length <= 200 && ID.test(value) ? value : invalid('package id');
const versionOf = (value: unknown): string => { if (typeof value !== 'string') return invalid('version'); compareMarketplaceVersions(value, value); return value; };
const textOf = (value: unknown, max = 200): string => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid('text');
const cursorOf = (value: unknown): string | null => value === null ? null : typeof value === 'string' && ULID.test(value) ? value : invalid('cursor');
function positive(value: number, maximum: number): number { if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) return invalid('limit'); return value; }
function originOf(value: string): string {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return invalid('HTTPS origin');
    return url.origin;
}
function inside(parent: string, child: string): boolean { const path = relative(resolve(parent), resolve(child)); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); }
function permissionsOf(raw: unknown): PluginCapabilities {
    // Use the host's actual manifest normalizer, retaining no undeclared capability keys.
    const parsed = parseManifest({ id: 'org.genie.permissions', name: 'Permissions', version: '1.0.0', publisher: { name: 'Registry', keyId: 'validation' }, capabilities: raw });
    if (!record(raw) || !parsed.ok) return invalid('permissions');
    return parsed.manifest.capabilities;
}
function publisherOf(raw: unknown): MarketplacePackage['publisher'] {
    if (!record(raw) || typeof raw.id !== 'string' || !ULID.test(raw.id) || !record(raw.verification)) return invalid('publisher identity');
    const method = raw.verification.method, identity = textOf(raw.verification.identity, 253);
    if (method !== 'domain' && method !== 'github_org') return invalid('publisher verification');
    return { id: raw.id, name: textOf(raw.name, 100), verification: { method, identity } };
}
function versionData(raw: unknown, id: string, origin: string): MarketplaceVersion {
    if (!record(raw)) return invalid('version metadata');
    const version = versionOf(raw.version);
    const expected = `${origin}/api/v1/marketplace/packages/${id}/versions/${encodeURIComponent(version)}/download`;
    if (raw.download_url !== expected) return invalid('registry download URL or origin');
    if (typeof raw.digest !== 'string' || !DIGEST.test(raw.digest) || typeof raw.key_id !== 'string' || !KEY.test(raw.key_id)) return invalid('digest or publisher key');
    if (!Number.isSafeInteger(raw.file_count) || (raw.file_count as number) < 1 || (raw.file_count as number) > 10_000 || !Number.isSafeInteger(raw.uncompressed_size) || (raw.uncompressed_size as number) < 0 || (raw.uncompressed_size as number) > 200 * 1024 * 1024) return invalid('package size limits');
    const published = textOf(raw.published_at, 64);
    if (!Number.isFinite(Date.parse(published))) return invalid('publication time');
    return { version, digest: raw.digest, key_id: raw.key_id, permissions: permissionsOf(raw.permissions), file_count: raw.file_count as number, uncompressed_size: raw.uncompressed_size as number, published_at: published, download_url: expected };
}
function packageData(raw: unknown, origin: string): MarketplacePackage {
    if (!record(raw)) return invalid('package metadata');
    const id = idOf(raw.id);
    return { id, name: textOf(raw.name), publisher: publisherOf(raw.publisher), version: versionData(raw.version, id, origin) };
}
function grantsOf(raw: unknown): Map<string, Grant> {
    if (!Array.isArray(raw) || raw.length > 10_000) return invalid('consent records');
    const grants = new Map<string, Grant>();
    for (const row of raw) {
        if (!record(row) || typeof row.digest !== 'string' || !DIGEST.test(row.digest) || typeof row.keyId !== 'string' || !KEY.test(row.keyId) || typeof row.publisherId !== 'string' || !ULID.test(row.publisherId)) return invalid('consent record');
        const id = idOf(row.id); if (grants.has(id)) return invalid('duplicate consent');
        grants.set(id, { id, version: versionOf(row.version), digest: row.digest, keyId: row.keyId, publisherId: row.publisherId, capabilities: permissionsOf(row.capabilities) });
    }
    return grants;
}
async function readJson(file: string, limit: number): Promise<unknown> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Invalid Marketplace storage file or size');
    const input = await open(file, 'r'); const chunks: Buffer[] = []; let size = 0;
    try {
        for (;;) {
            const chunk = Buffer.alloc(64 * 1024); const result = await input.read(chunk);
            if (!result.bytesRead) break; size += result.bytesRead;
            if (size > limit) throw new Error('Marketplace storage file exceeds its size limit');
            chunks.push(chunk.subarray(0, result.bytesRead));
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally { await input.close(); }
}
async function writeJson(file: string, value: unknown, limit: number): Promise<void> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > limit) throw new Error('Marketplace storage file exceeds its size limit');
    const tmp = `${file}.${randomUUID()}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    try {
        const output = await open(tmp, 'wx', 0o600);
        try { await output.writeFile(text, 'utf8'); await output.sync(); } finally { await output.close(); }
        await rename(tmp, file);
    } finally { await rm(tmp, { force: true }); }
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void pending.catch(() => {}); signal.throwIfAborted(); }
    let cancel!: () => void;
    const stopped = new Promise<never>((_yes, no) => { cancel = () => no(signal.reason ?? new Error('Marketplace request cancelled')); signal.addEventListener('abort', cancel, { once: true }); });
    try { return await Promise.race([pending, stopped]); }
    finally { signal.removeEventListener('abort', cancel); }
}
async function jsonBody(response: Awaited<ReturnType<MarketplaceFetch>>, signal: AbortSignal): Promise<unknown> {
    if (response.headers?.get('content-length') && (!/^\d+$/.test(response.headers.get('content-length')!) || Number(response.headers.get('content-length')) > MARKETPLACE_PAGE_BYTES)) throw new Error('Marketplace metadata exceeds its size limit');
    let text: string;
    if (!response.body) text = await abortable(response.text(), signal);
    else {
        const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
        try {
            for (;;) {
                const next = await abortable(reader.read(), signal); if (next.done) break;
                size += next.value.length; if (size > MARKETPLACE_PAGE_BYTES) throw new Error('Marketplace metadata exceeds its size limit');
                chunks.push(next.value);
            }
            text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (Buffer.byteLength(text) > MARKETPLACE_PAGE_BYTES) throw new Error('Marketplace metadata exceeds its size limit');
    return JSON.parse(text);
}

/** Host-owned review tokens bind consent to verified bytes. A renderer can request an action, never supply authority. */
export class MarketplaceHost implements MarketplaceApi {
    readonly #options: MarketplaceHostOptions;
    readonly #origin: string;
    readonly #now: () => number;
    readonly #maxAge: number;
    readonly #maxArchive: number;
    readonly #timeout: number;
    #grants = new Map<string, Grant>();
    readonly #reviews = new Map<string, Staged>();
    readonly #controllers = new Set<AbortController>();
    readonly #pending = new Set<Promise<unknown>>();
    #session = '';
    #closed = false;
    #busy = false;
    #sweep: ReturnType<typeof setInterval> | null = null;
    #closing: Promise<void> | null = null;
    #needsRecovery = false;
    readonly #cleanup = new Set<string>();

    private constructor(options: MarketplaceHostOptions) {
        this.#options = options;
        this.#origin = originOf(options.origin ?? 'https://tynn.ai');
        this.#now = options.now ?? Date.now;
        this.#maxAge = positive(options.reviewMaxAgeMs ?? 10 * 60_000, 60 * 60_000);
        this.#maxArchive = positive(options.maxArchiveBytes ?? MARKETPLACE_ARCHIVE_BYTES, MARKETPLACE_ARCHIVE_BYTES);
        this.#timeout = positive(options.timeoutMs ?? 120_000, 10 * 60_000);
        if (inside(options.pluginsDir, options.stagingDir) || inside(options.stagingDir, options.pluginsDir) || inside(options.pluginsDir, options.grantsFile)) throw new Error('Marketplace staging and consent storage must be outside the live plugins directory');
    }
    static async open(options: MarketplaceHostOptions): Promise<MarketplaceHost> {
        const host = new MarketplaceHost(options);
        await mkdir(options.stagingDir, { recursive: true, mode: 0o700 });
        if (!(await lstat(options.stagingDir)).isDirectory() || (await lstat(options.stagingDir)).isSymbolicLink()) throw new Error('Marketplace staging must be a plain directory');
        await host.#recover();
        await host.#readGrants();
        host.#session = await mkdtemp(join(options.stagingDir, 'reviews-'));
        host.#sweep = setInterval(() => { void host.#expire().catch(() => {}); }, Math.min(host.#maxAge, 60_000));
        host.#sweep.unref?.();
        return host;
    }
    #assertOpen(): void {
        if (this.#closed) throw new Error('Marketplace host is closed');
        if (this.#needsRecovery) throw new Error('Marketplace recovery needs attention before another installation can begin.');
    }
    async #operation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
        this.#assertOpen();
        if (this.#controllers.size >= 4) throw new Error('Marketplace request limit reached; try again when the current request finishes');
        const controller = new AbortController(); this.#controllers.add(controller);
        const timer = setTimeout(() => controller.abort(new Error('Marketplace request timed out')), this.#timeout);
        const pending = Promise.resolve().then(() => work(controller.signal)); this.#pending.add(pending);
        try { return await pending; }
        finally { clearTimeout(timer); controller.abort(); this.#controllers.delete(controller); this.#pending.delete(pending); }
    }
    async #json(path: string, signal: AbortSignal): Promise<unknown> {
        signal.throwIfAborted();
        const response = await abortable(this.#options.fetch(`${this.#origin}${path}`, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal }), signal);
        if (!response.ok || response.status !== 200) throw new Error(`Marketplace registry answered ${response.status}`);
        return jsonBody(response, signal);
    }
    search(query: string, cursor?: string): ReturnType<MarketplaceApi['search']> {
        return this.#operation(async signal => {
            if (typeof query !== 'string' || [...query].length > 100) return invalid('search query');
            if (cursor !== undefined) cursorOf(cursor);
            const params = new URLSearchParams(); if (query) params.set('q', query); if (cursor) params.set('cursor', cursor);
            const data = await this.#json(`/api/v1/marketplace/packages${params.size ? `?${params}` : ''}`, signal);
            if (!record(data) || !Array.isArray(data.packages) || data.packages.length > 50) return invalid('package page');
            const rows: MarketplaceRow[] = []; const seen = new Set<string>();
            for (const raw of data.packages) {
                let pkg = packageData(raw, this.#origin);
                if (seen.has(pkg.id)) return invalid('duplicate package'); seen.add(pkg.id);
                const entry = this.#options.plugins.dump().entries.find(item => item.id === pkg.id);
                if (entry?.version) pkg = await this.#latest(pkg, signal);
                rows.push({ ...pkg, installedVersion: entry?.version ?? null, updateAvailable: !!entry?.version && compareMarketplaceVersions(pkg.version.version, entry.version) > 0 });
            }
            return { packages: rows, nextCursor: cursorOf(data.next_cursor) };
        });
    }
    async #latest(pkg: MarketplacePackage, signal: AbortSignal): Promise<MarketplacePackage> {
        let best = pkg.version, cursor: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; ; page++) {
            if (page >= 50) throw new Error('Marketplace version page limit exceeded');
            const data = await this.#json(`/api/v1/marketplace/packages/${pkg.id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, signal);
            if (!record(data) || data.id !== pkg.id || !Array.isArray(data.versions) || data.versions.length > 50 || !isDeepStrictEqual(publisherOf(data.publisher), pkg.publisher)) return invalid('package versions page');
            for (const raw of data.versions) { const version = versionData(raw, pkg.id, this.#origin); if (compareMarketplaceVersions(version.version, best.version) > 0) best = version; }
            cursor = cursorOf(data.next_cursor); if (cursor === null) break;
            if (seen.has(cursor)) throw new Error('Marketplace version cursor loop'); seen.add(cursor);
        }
        return { ...pkg, version: best };
    }
    async #baseline(pkg: MarketplacePackage): Promise<Baseline> {
        const dump = this.#options.plugins.dump();
        const entries = dump.entries.filter(item => item.id === pkg.id);
        if (entries.length > 1) throw new Error('Duplicate installed package id; resolve it before updating');
        const entry = entries[0];
        if (!entry) return { folder: null, version: null, digest: null, capabilities: null };
        if (entry.folder === '(official)') throw new Error('Marketplace packages cannot replace an official Genie plugin');
        const folder = join(this.#options.pluginsDir, entry.folder);
        if (!inside(this.#options.pluginsDir, folder) || resolve(folder) === resolve(this.#options.pluginsDir) || (await lstat(folder)).isSymbolicLink()) throw new Error('Invalid installed package folder');
        const current = await currentDigest(folder);
        if (!current.ok) throw new Error(current.reason);
        const grant = this.#grants.get(pkg.id), manifest = dump.manifests[pkg.id];
        const trustedBaseline = grant && manifest && entry.unverified === false && grant.version === entry.version && grant.digest === current.digest && grant.keyId === manifest.publisher.keyId && grant.keyId === pkg.version.key_id && grant.publisherId === pkg.publisher.id && isDeepStrictEqual(grant.capabilities, manifest.capabilities);
        return { folder, version: entry.version, digest: current.digest, capabilities: trustedBaseline ? grant.capabilities : null };
    }
    async #verify(dir: string, pkg: MarketplacePackage): Promise<PluginManifest> {
        const registry = this.#options.registry;
        if (registry.keyState(pkg.version.key_id) !== 'trusted') throw new Error('Publisher registry key is withdrawn or no longer trusted; refresh before installing');
        const parsed = parseManifest(JSON.parse(await readFile(join(dir, 'genie-plugin.json'), 'utf8')));
        if (!parsed.ok) throw new Error(`Invalid package manifest: ${parsed.reason}`);
        const manifest = parsed.manifest;
        if (manifest.id !== pkg.id || manifest.version !== pkg.version.version || manifest.publisher.keyId !== pkg.version.key_id || manifest.publisher.name !== pkg.publisher.name || manifest.name !== pkg.name) throw new Error('Signed manifest identity disagrees with registry metadata');
        if (!isDeepStrictEqual(manifest.capabilities, pkg.version.permissions)) throw new Error('Signed manifest permissions disagree with registry metadata');
        const checked = await checkPackage(dir, { keyId: manifest.publisher.keyId, keys: registry.publisherKeys(), publisherChecksOff: false });
        if (!checked.decision.install || checked.digest !== pkg.version.digest) throw new Error(`Package signature or digest is tampered: ${!checked.decision.install ? checked.decision.reason : 'digest disagrees with registry metadata'}`);
        return manifest;
    }
    prepare(id: string, version: string): Promise<MarketplaceReview> {
        return this.#operation(async signal => {
            idOf(id); versionOf(version);
            if (this.#busy) throw new Error('A Marketplace install is in progress');
            this.#busy = true;
            let dir: string | null = null;
            try {
                await this.#expire();
                if (this.#reviews.size + this.#cleanup.size >= 4) throw new Error('Marketplace review/staging limit reached; cancel a review or resolve the staging cleanup error first');
                const pkg = packageData(await this.#json(`/api/v1/marketplace/packages/${id}/versions/${encodeURIComponent(version)}`, signal), this.#origin);
                if (pkg.id !== id || pkg.version.version !== version) return invalid('requested package identity');
                await abortable(this.#options.registry.refresh(), signal);
                const baseline = await this.#baseline(pkg);
                dir = await mkdtemp(join(this.#session, 'package-'));
                const archive = join(dir, 'download.zip'), extracted = join(dir, 'contents');
                await mkdir(extracted, { mode: 0o700 });
                const response = await abortable(this.#options.fetch(pkg.version.download_url, { method: 'GET', headers: { Accept: 'application/zip' }, credentials: 'omit', redirect: 'error', signal }), signal);
                if (!response.ok || response.status !== 200 || !response.body) throw new Error(`Marketplace download failed (${response.status}); a binary response is required`);
                const length = response.headers?.get('content-length');
                if (length && (!/^\d+$/.test(length) || Number(length) > this.#maxArchive)) throw new Error('Marketplace archive exceeds its size limit');
                const reader = response.body.getReader(); const output = await open(archive, 'wx', 0o600); let size = 0;
                try {
                    for (;;) { const next = await abortable(reader.read(), signal); if (next.done) break; size += next.value.byteLength; if (size > this.#maxArchive) throw new Error('Marketplace archive exceeds its size limit'); await output.writeFile(next.value); }
                } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await output.close(); }
                const sizes = await extractMarketplaceArchive(archive, extracted, signal);
                const manifest = await this.#verify(extracted, pkg);
                if (sizes.fileCount !== pkg.version.file_count || sizes.uncompressedSize !== pkg.version.uncompressed_size) throw new Error('Archive size/count disagrees with registry metadata');
                signal.throwIfAborted();
                const token = randomBytes(32).toString('hex');
                const review: MarketplaceReview = { token, package: pkg, manifest, installedVersion: baseline.version, needsConsent: needsMarketplaceConsent(baseline.capabilities, manifest.capabilities) };
                // Keep an independent host copy: neither an in-process caller nor a renderer may rewrite reviewed authority.
                this.#reviews.set(token, { review: structuredClone(review), dir, baseline, expires: this.#now() + this.#maxAge }); dir = null;
                return review;
            } finally { this.#busy = false; if (dir) await this.#removeStaged(dir); }
        });
    }
    install(token: string, consent: boolean): Promise<{ id: string; version: string }> {
        return this.#operation(async signal => {
            const staged = this.#reviews.get(token);
            if (!staged || this.#now() >= staged.expires) { if (staged) await this.discard(token); throw new Error('Unknown or expired Marketplace review token'); }
            if (staged.review.needsConsent && consent !== true) throw new Error('Explicit consent is required for these package permissions');
            if (this.#busy) throw new Error('A Marketplace install is already in progress');
            this.#busy = true; this.#reviews.delete(token);
            const pkg = staged.review.package, extracted = join(staged.dir, 'contents');
            const previousGrants = new Map(this.#grants);
            const target = staged.baseline.folder ?? join(this.#options.pluginsDir, pkg.id), backup = join(staged.dir, 'previous');
            let movedOld = false, movedNew = false, wroteGrants = false, preserve = false, journaled = false;
            try {
                await abortable(this.#options.registry.refresh(), signal);
                const manifest = await this.#verify(extracted, pkg);
                const baseline = await this.#baseline(pkg);
                if (!isDeepStrictEqual(baseline, staged.baseline)) throw new Error('Installed package changed after review; prepare a new review');
                signal.throwIfAborted();
                // A durable recovery record precedes BOTH the grant change and directory renames.
                await writeJson(join(this.#options.stagingDir, 'activation.json'), {
                    version: 1, origin: this.#origin, id: pkg.id, folder: relative(this.#options.pluginsDir, target),
                    transaction: relative(this.#options.stagingDir, staged.dir).split(sep).join('/'),
                    previousDigest: baseline.digest, nextDigest: pkg.version.digest, previousGrants: [...previousGrants.values()],
                }, JOURNAL_BYTES);
                journaled = true;
                // Persist before activation. A crash before activation cannot make a different digest count as consented.
                const next = new Map(this.#grants);
                next.set(pkg.id, { id: pkg.id, version: manifest.version, digest: pkg.version.digest, keyId: manifest.publisher.keyId, publisherId: pkg.publisher.id, capabilities: manifest.capabilities });
                if (next.size > 10_000) throw new Error('Marketplace consent count exceeds its limit');
                await this.#writeGrants(next); wroteGrants = true;
                await mkdir(this.#options.pluginsDir, { recursive: true });
                if (staged.baseline.folder) { await rename(target, backup); movedOld = true; }
                else { try { await lstat(target); throw new Error('The package destination already exists; refresh before installing'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
                signal.throwIfAborted();
                if (this.#options.registry.keyState(pkg.version.key_id) !== 'trusted') throw new Error('Publisher key was withdrawn before activation');
                await rename(extracted, target); movedNew = true;
                await this.#options.plugins.reload();
                const entry = this.#options.plugins.dump().entries.find(item => item.id === pkg.id);
                if (!entry || entry.version !== manifest.version || !['enabled', 'disabled'].includes(entry.state) || entry.unverified !== false) throw new Error(`Installed package could not be loaded: ${entry?.reason ?? 'unavailable'}`);
                await rm(join(this.#options.stagingDir, 'activation.json'));
                this.#grants = next;
                return { id: pkg.id, version: manifest.version };
            } catch (error) {
                try {
                    if (movedNew) await rename(target, extracted);
                    if (movedOld) await rename(backup, target);
                    if (wroteGrants) await this.#writeGrants(previousGrants);
                    await this.#options.plugins.reload();
                    if (journaled) await rm(join(this.#options.stagingDir, 'activation.json'));
                } catch (rollback) { preserve = true; this.#needsRecovery = true; throw new AggregateError([error, rollback], `Marketplace install failed and recovery needs attention; previous files retained at ${staged.dir}`); }
                throw error;
            } finally { this.#busy = false; if (!preserve) await this.#removeStaged(staged.dir); }
        });
    }
    async #removeStaged(dir: string): Promise<void> {
        try { await rm(dir, { recursive: true, force: true }); this.#cleanup.delete(dir); }
        catch (error) { this.#cleanup.add(dir); this.#options.log?.(`Marketplace staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    async discard(token: string): Promise<void> { const staged = this.#reviews.get(token); if (!staged) return; this.#reviews.delete(token); await this.#removeStaged(staged.dir); }
    async #expire(): Promise<void> {
        for (const dir of [...this.#cleanup]) await this.#removeStaged(dir);
        for (const [token, staged] of this.#reviews) if (this.#now() >= staged.expires) await this.discard(token);
    }
    async #recover(): Promise<void> {
        const journal = join(this.#options.stagingDir, 'activation.json');
        let raw: unknown;
        try { raw = await readJson(journal, JOURNAL_BYTES); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Marketplace recovery journal cannot be read; retained files need attention.', { cause: error }); }
        if (!record(raw) || raw.version !== 1 || raw.origin !== this.#origin || typeof raw.id !== 'string' || !ID.test(raw.id)
            || typeof raw.folder !== 'string' || !raw.folder || raw.folder === '.' || raw.folder === '..' || /[\\/:\u0000-\u001f]/.test(raw.folder)
            || typeof raw.transaction !== 'string' || !/^reviews-[A-Za-z0-9]+\/package-[A-Za-z0-9]+$/.test(raw.transaction)
            || (raw.previousDigest !== null && (typeof raw.previousDigest !== 'string' || !DIGEST.test(raw.previousDigest)))
            || typeof raw.nextDigest !== 'string' || !DIGEST.test(raw.nextDigest)) throw new Error('Invalid Marketplace recovery journal paths or digest');
        const previousGrants = grantsOf(raw.previousGrants);
        const transaction = join(this.#options.stagingDir, raw.transaction), target = join(this.#options.pluginsDir, raw.folder), backup = join(transaction, 'previous');
        const plain = async (path: string): Promise<boolean> => {
            try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Marketplace recovery path is not a plain directory'); return true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
        };
        if (!inside(this.#options.stagingDir, transaction) || !inside(this.#options.pluginsDir, target) || !await plain(dirname(transaction)) || !await plain(transaction)) throw new Error('Invalid Marketplace recovery journal transaction path');
        const digest = async (folder: string): Promise<string | null> => {
            if (!await plain(folder)) return null;
            const current = await currentDigest(folder);
            const manifest = JSON.parse(await readFile(join(folder, 'genie-plugin.json'), 'utf8')) as { id?: unknown };
            if (!current.ok || manifest.id !== raw.id) throw new Error('Marketplace recovery package identity or digest cannot be verified; files retained.');
            return current.digest;
        };
        const old = await digest(backup), current = await digest(target);
        if ((old !== null && old !== raw.previousDigest) || (current !== null && current !== raw.previousDigest && current !== raw.nextDigest) || (raw.previousDigest !== null && old === null && current !== raw.previousDigest)) throw new Error('Marketplace recovery digest changed; files retained for review.');
        const movedCurrent = current === raw.nextDigest && (old !== null || raw.previousDigest === null);
        if (movedCurrent) await rename(target, join(transaction, 'interrupted'));
        if (old !== null) {
            if (current === raw.previousDigest && !movedCurrent) throw new Error('Marketplace recovery found two previous directories; files retained.');
            await rename(backup, target);
        }
        await this.#writeGrants(previousGrants);
        await this.#options.plugins.reload();
        await rm(journal);
        await rm(transaction, { recursive: true, force: true });
        await rmdir(dirname(transaction)).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
    }
    async #readGrants(): Promise<void> {
        try {
            const raw = await readJson(this.#options.grantsFile, BOOK_BYTES);
            if (!record(raw) || raw.version !== 1 || raw.origin !== this.#origin) return invalid('consent book');
            this.#grants = grantsOf(raw.grants);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    async #writeGrants(grants: Map<string, Grant>): Promise<void> {
        await writeJson(this.#options.grantsFile, { version: 1, origin: this.#origin, grants: [...grants.values()] }, BOOK_BYTES);
    }
    close(): Promise<void> {
        if (this.#closing) return this.#closing;
        this.#closed = true;
        if (this.#sweep) clearInterval(this.#sweep); this.#sweep = null;
        for (const controller of this.#controllers) controller.abort(new Error('Marketplace host closed'));
        this.#closing = (async () => {
            await Promise.allSettled([...this.#pending]);
            for (const token of [...this.#reviews.keys()]) await this.discard(token);
            for (const dir of [...this.#cleanup]) await this.#removeStaged(dir);
            // Only remove an empty owned session: a failed rollback's retained backup must survive shutdown.
            await rmdir(this.#session).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
        })();
        return this.#closing;
    }
}
