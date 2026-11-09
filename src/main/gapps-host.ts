import { renameOver } from '../core/atomic-rename.js';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validatePackage, type Catalog, type ElementDefinition } from '../core/catalog.js';
import { grantFor, installReview, updateReview, type GAppGrant, type GAppRequest, type GrantScope, type ReviewItem } from '../core/gapp-grants.js';
import { UNVERIFIED_LABEL } from '../core/plugins.js';
import type { PackageDeclaration } from './genie-catalog.js';
import { checkPackage, currentDigest } from './plugin-package.js';

/**
 * THE GAPP BOOK IN GENIE-HOST (GApps v2, V3, Tynn #568; spec .ai/plans/specs/gapps-v2.md, approved 2026-11-08).
 *
 * An app is a signed genie-package/1 package whose manifest, `genie-package.json` (decision 1), lists its contributions
 * in the catalog's own envelope; exactly one is an `app`. The book installs it from a folder in two steps, so what the
 * person consents to is exactly what is installed:
 *  1. `reviewInstall`: B4's package check (digest, signature, limits) and B5's rule (unsigned only with publisher checks
 *     off: Unverified), the contributions validated by the catalog, then V2's review by Genie's catalog names;
 *  2. `install` with the person's consent to that review: everything checked again, and refused if the package changed
 *     since; the files copied into the book (and their digest checked again there), the grant written, the package
 *     registered in the host's catalog (source `gapp`, through `packages()`).
 * An update asks again only for what is new (V2); its grant keeps the scope the person gave. Turn off leaves the catalog
 * and keeps grant and storage; uninstall leaves nothing of the app. No workspace is ever made for an app (decision 2).
 *
 * The book's own record is `<dir>/book.json`; each app's files are `<dir>/<packageId>/<version>/`, its isolated store
 * `<dir>/<packageId>/storage/` (the bridge's, V5).
 */
export const GAPP_MANIFEST_FILE = 'genie-package.json';

export interface GAppEntry {
    readonly packageId: string;
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    readonly state: 'installed' | 'off';
    /** Running only because publisher checks are off (B5). */
    readonly unverified: boolean;
    readonly grant: GAppGrant;
}

export interface GAppReview {
    readonly packageId: string;
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    /** The signing key's id, or `unverified`. */
    readonly publisher: string;
    /** An update to an installed app (its grant is the baseline). */
    readonly update: boolean;
    /** Whether the person must consent: always for a new app; for an update, only when it asks for something new. */
    readonly consent: boolean;
    /** What the person reads: each element by Genie's catalog name, each host, a new publisher. */
    readonly items: readonly ReviewItem[];
}

export interface GAppBookPorts {
    /** `<home>/gapps`. */
    readonly dir: string;
    /** Publisher keys Genie holds, by their C1 id. */
    readonly keys: Readonly<Record<string, string>>;
    readonly publisherChecksOff: () => boolean;
    /** The host's catalog as it is now: the review names elements from it, and a new package must not collide in it. */
    readonly catalog: () => Catalog;
    readonly now?: () => number;
}

interface Book { readonly apps: readonly GAppEntry[] }
type Prepared = { ok: true; review: GAppReview; declaration: PackageDeclaration; request: GAppRequest; unverified: boolean } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameItems = (a: readonly ReviewItem[], b: readonly ReviewItem[]) => {
    const keys = new Set(b.map((i) => JSON.stringify(i)));
    return a.every((i) => keys.has(JSON.stringify(i)));
};

/** `genie-package.json` read as a package declaration: its contributions in the catalog's envelope, filled with the package's id, version and source. */
function declarationOf(raw: unknown): { ok: true; declaration: PackageDeclaration; name: string; keyId: string | null } | { ok: false; reason: string } {
    if (!isRecord(raw)) return { ok: false, reason: `${GAPP_MANIFEST_FILE} must be a JSON object` };
    if (typeof raw.id !== 'string' || typeof raw.version !== 'string' || typeof raw.name !== 'string' || raw.name.trim() === '') return { ok: false, reason: `${GAPP_MANIFEST_FILE} must name its id, name and version` };
    if (!isRecord(raw.publisher) || typeof raw.publisher.name !== 'string') return { ok: false, reason: `${GAPP_MANIFEST_FILE} must name its publisher: publisher.name` };
    const keyId = typeof raw.publisher.keyId === 'string' ? raw.publisher.keyId : null;
    if (!Array.isArray(raw.contributions)) return { ok: false, reason: `${GAPP_MANIFEST_FILE} must list its contributions` };
    const id = raw.id;
    const version = raw.version;
    const declaration = {
        id, version, source: 'gapp' as const,
        contributions: raw.contributions.map((c) => (isRecord(c) ? { ...c, packageId: id, source: 'gapp', version } : c)) as unknown as ElementDefinition[],
    };
    const check = validatePackage(declaration);
    if (!check.ok) return { ok: false, reason: check.problems.join('; ') };
    const apps = check.pkg.contributions.filter((d) => d.kind === 'app');
    if (apps.length !== 1) return { ok: false, reason: `a GApp contributes exactly one app element; this package has ${apps.length}` };
    return { ok: true, declaration: check.pkg, name: raw.name, keyId };
}

export class GAppBook {
    readonly #ports: GAppBookPorts;
    #book: Book;
    readonly #packages = new Map<string, PackageDeclaration>();
    readonly #listeners = new Set<() => void>();
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(ports: GAppBookPorts, book: Book) {
        this.#ports = ports;
        this.#book = book;
    }

    static async open(ports: GAppBookPorts): Promise<GAppBook> {
        let book: Book = { apps: [] };
        try {
            const raw: unknown = JSON.parse(await readFile(join(ports.dir, 'book.json'), 'utf8'));
            if (isRecord(raw) && Array.isArray(raw.apps)) book = { apps: raw.apps as GAppEntry[] };
        } catch { /* no book yet */ }
        const gapps = new GAppBook(ports, book);
        for (const entry of book.apps) await gapps.#loadDeclaration(entry);
        return gapps;
    }

    list(): readonly GAppEntry[] {
        return this.#book.apps;
    }

    /** The installed, turned-on apps' packages, for the host's catalog (main/genie-catalog.ts hostCatalog). */
    packages(): readonly PackageDeclaration[] {
        return this.#book.apps.filter((e) => e.state === 'installed').flatMap((e) => this.#packages.get(e.packageId) ?? []);
    }

    /** An app's isolated store (V5's bridge reads and writes it). */
    storageDir(packageId: string): string {
        return join(this.#ports.dir, packageId, 'storage');
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** What the person reads before an app is installed or updated from this folder, or why it cannot be. */
    async reviewInstall(dir: string): Promise<{ ok: true; review: GAppReview } | { ok: false; reason: string }> {
        const prepared = await this.#prepare(dir);
        return prepared.ok ? { ok: true, review: prepared.review } : prepared;
    }

    /**
     * Install or update from this folder. Where the review asks for consent, `consent` must be the person's to THAT review:
     * the same digest, and every item they read; anything else is refused and nothing is written.
     */
    install(dir: string, options: { scope: GrantScope; consent?: { digest: string; items: readonly ReviewItem[] } }): Promise<{ ok: true; entry: GAppEntry } | { ok: false; reason: string }> {
        return this.#serial(async () => {
            const prepared = await this.#prepare(dir);
            if (!prepared.ok) return prepared;
            const { review, declaration, request, unverified } = prepared;
            if (review.consent) {
                if (!options.consent) return { ok: false, reason: `${review.name} ${review.version} needs the person's consent to what it asks for; nothing was installed` };
                if (options.consent.digest !== review.digest || !sameItems(review.items, options.consent.items)) {
                    return { ok: false, reason: `${review.name} changed since the person reviewed it; nothing was installed. Review it again.` };
                }
            }
            const existing = this.#book.apps.find((e) => e.packageId === review.packageId);
            const appDir = join(this.#ports.dir, review.packageId);
            const target = join(appDir, review.version);
            const staging = join(appDir, `.staging-${process.pid}-${Date.now()}`);
            await mkdir(appDir, { recursive: true });
            await mkdir(this.storageDir(review.packageId), { recursive: true });
            try {
                await cp(dir, staging, { recursive: true, errorOnExist: false, force: true });
                // What was copied is what was reviewed: checked again in the book, so nothing changed in between.
                const copied = await currentDigest(staging);
                if (!copied.ok || copied.digest !== review.digest) throw new Error(`${review.name} changed while it was being installed; nothing was installed`);
                await rm(target, { recursive: true, force: true });
                await rename(staging, target);
            } catch (error) {
                await rm(staging, { recursive: true, force: true });
                if (!existing) await rm(appDir, { recursive: true, force: true });
                return { ok: false, reason: (error as Error).message };
            }
            if (existing && existing.version !== review.version) await rm(join(appDir, existing.version), { recursive: true, force: true });
            const grant = grantFor(request, { scope: existing ? existing.grant.scope : options.scope, now: (this.#ports.now ?? Date.now)() });
            const entry: GAppEntry = { packageId: review.packageId, name: review.name, version: review.version, digest: review.digest, state: existing?.state ?? 'installed', unverified, grant };
            this.#packages.set(entry.packageId, declaration);
            await this.#write({ apps: [...this.#book.apps.filter((e) => e.packageId !== entry.packageId), entry] });
            return { ok: true, entry };
        });
    }

    /** Turn an installed app off (out of the catalog; grant and storage kept) or back on. `false` for an unknown app. */
    setOn(packageId: string, on: boolean): Promise<boolean> {
        return this.#serial(async () => {
            const entry = this.#book.apps.find((e) => e.packageId === packageId);
            if (!entry) return false;
            await this.#write({ apps: this.#book.apps.map((e) => (e.packageId === packageId ? { ...e, state: on ? 'installed' : 'off' } : e)) });
            return true;
        });
    }

    /** Remove the app: its files, grant, storage and catalog element. `false` for an unknown app. */
    uninstall(packageId: string): Promise<boolean> {
        return this.#serial(async () => {
            if (!this.#book.apps.some((e) => e.packageId === packageId)) return false;
            this.#packages.delete(packageId);
            await this.#write({ apps: this.#book.apps.filter((e) => e.packageId !== packageId) });
            await rm(join(this.#ports.dir, packageId), { recursive: true, force: true });
            return true;
        });
    }

    async #prepare(dir: string): Promise<Prepared> {
        let raw: unknown;
        try {
            raw = JSON.parse(await readFile(join(dir, GAPP_MANIFEST_FILE), 'utf8'));
        } catch {
            return { ok: false, reason: `no readable ${GAPP_MANIFEST_FILE} in the folder: a GApp is a package with one` };
        }
        const parsed = declarationOf(raw);
        if (!parsed.ok) return parsed;
        const { declaration } = parsed;
        const check = await checkPackage(dir, { keyId: parsed.keyId ?? '', keys: this.#ports.keys, publisherChecksOff: this.#ports.publisherChecksOff() });
        if (!check.decision.install) return { ok: false, reason: check.decision.reason };
        const unverified = check.decision.label === UNVERIFIED_LABEL;
        // A signed package's digest comes with its check; an unsigned one's is taken here (B4 holds none for it).
        let digestHex = check.digest;
        if (digestHex === null) {
            const now = await currentDigest(dir);
            if (!now.ok) return { ok: false, reason: now.reason };
            digestHex = now.digest;
        }
        // Its element ids must not take another package's in Genie's catalog.
        const catalog = this.#ports.catalog();
        const trial = catalog.register(declaration);
        if (!trial.ok) return { ok: false, reason: trial.problems.join('; ') };
        const app = declaration.contributions.find((d) => d.kind === 'app')!;
        const request: GAppRequest = {
            packageId: declaration.id, version: declaration.version, digest: digestHex, publisher: unverified ? 'unverified' : (parsed.keyId ?? 'unverified'),
            uses: Array.isArray(app.payload.uses) ? (app.payload.uses as string[]) : [], network: [...app.permissions.network],
        };
        const lookup = (id: string) => catalog.get(id);
        const existing = this.#book.apps.find((e) => e.packageId === declaration.id);
        if (existing) {
            const r = updateReview(existing.grant, request, lookup);
            if (!r.ok) return { ok: false, reason: r.problems.join('; ') };
            const review: GAppReview = { packageId: declaration.id, name: parsed.name, version: declaration.version, digest: digestHex, publisher: request.publisher, update: true, consent: r.consent, items: r.consent ? r.items : [] };
            return { ok: true, review, declaration, request, unverified };
        }
        const r = installReview(request, lookup);
        if (!r.ok) return { ok: false, reason: r.problems.join('; ') };
        const review: GAppReview = { packageId: declaration.id, name: parsed.name, version: declaration.version, digest: digestHex, publisher: request.publisher, update: false, consent: true, items: r.items };
        return { ok: true, review, declaration, request, unverified };
    }

    async #loadDeclaration(entry: GAppEntry): Promise<void> {
        try {
            const parsed = declarationOf(JSON.parse(await readFile(join(this.#ports.dir, entry.packageId, entry.version, GAPP_MANIFEST_FILE), 'utf8')));
            if (parsed.ok) this.#packages.set(entry.packageId, parsed.declaration);
        } catch { /* its files are gone: it is listed, and offers nothing until reinstalled */ }
    }

    async #write(book: Book): Promise<void> {
        const file = join(this.#ports.dir, 'book.json');
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(book, null, 2), 'utf8');
        await renameOver(tmp, file);
        this.#book = book;
        for (const listener of [...this.#listeners]) listener();
    }

    #serial<T>(work: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(work, work);
        this.#queue = run.then(() => undefined, () => undefined);
        return run;
    }
}
