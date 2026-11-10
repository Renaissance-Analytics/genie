import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renameOver } from '../core/atomic-rename.js';
import type { Catalog, ElementDefinition } from '../core/catalog.js';
import { grantFor, installReview, updateReview, type GAppGrant, type GAppRequest, type GrantScope } from '../core/gapp-grants.js';
import type { GAppReview } from '../core/gapps.js';
import { PACKAGE_MANIFEST_FILE } from '../core/plugin-integrity.js';
import { declarationOf } from './gapps-host.js';
import { checkPackage, currentDigest } from './plugin-package.js';

/**
 * PREVIEWS: A WORKSPACE'S OWN APP, RUN FROM ITS FOLDER (GApps v2, V8, Tynn #573; spec .ai/plans/specs/gapps-v2.md section
 * 5). A workspace whose folder holds a package with an `app` element has a dev launcher in the store. Run, it is a preview:
 *  - straight from the folder, never copied, and not re-checked before each run: the workspace is still building it;
 *  - unsigned allowed only here, as the workspace's own work in progress: Unverified, with no network until the person
 *    allows it (B5's rule for an unsigned package). A package signed as it is now has its publisher, and its granted hosts;
 *  - its own grant, asked like an install (V2's review, for its own workspace), kept in `<dir>/previews.json`;
 *  - its own store and its own origin (the bridge and the server, by `preview: true`).
 * One app per package id: a second workspace holding the same package is not offered, and says why.
 */
export interface GAppPreview {
    readonly packageId: string;
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    readonly workspaceId: string;
    readonly workspaceName: string;
    /** The signing key's id, or `unverified`. */
    readonly publisher: string;
    readonly unverified: boolean;
    /** An Unverified preview reaches no network until the person allows it. */
    readonly networkAllowed: boolean;
    readonly grant: GAppGrant | null;
}

export interface GAppPreviewsPorts {
    /** `<home>/gapps`, the book's own folder. */
    readonly dir: string;
    readonly workspaces: () => readonly { readonly id: string; readonly name: string; readonly path: string }[];
    readonly keys: Readonly<Record<string, string>>;
    readonly catalog: () => Catalog;
    readonly now?: () => number;
}

interface Kept { readonly grant: GAppGrant | null; readonly networkAllowed: boolean }
interface Found { readonly preview: Omit<GAppPreview, 'grant' | 'networkAllowed'>; readonly dir: string; readonly app: ElementDefinition; readonly request: GAppRequest }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class GAppPreviews {
    readonly #ports: GAppPreviewsPorts;
    #kept: Record<string, Kept>;
    #found = new Map<string, Found>();
    readonly #listeners = new Set<() => void>();
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(ports: GAppPreviewsPorts, kept: Record<string, Kept>) {
        this.#ports = ports;
        this.#kept = kept;
    }

    static async open(ports: GAppPreviewsPorts): Promise<GAppPreviews> {
        let kept: Record<string, Kept> = {};
        try {
            const raw: unknown = JSON.parse(await readFile(join(ports.dir, 'previews.json'), 'utf8'));
            if (isRecord(raw) && isRecord(raw.previews)) kept = raw.previews as Record<string, Kept>;
        } catch { /* none yet */ }
        const previews = new GAppPreviews(ports, kept);
        await previews.scan();
        return previews;
    }

    /** Read every workspace's folder again: what it holds now is what its launcher offers. */
    async scan(): Promise<void> {
        const found = new Map<string, Found>();
        for (const workspace of this.#ports.workspaces()) {
            const one = await this.#read(workspace);
            if (one && !found.has(one.preview.packageId)) found.set(one.preview.packageId, one);
        }
        this.#found = found;
    }

    list(): readonly GAppPreview[] {
        return [...this.#found.values()].map((f) => this.#withKept(f));
    }

    entry(packageId: string): GAppPreview | null {
        const found = this.#found.get(packageId);
        return found ? this.#withKept(found) : null;
    }

    /** The folder a preview is served from. */
    previewDir(packageId: string): string | null {
        return this.#found.get(packageId)?.dir ?? null;
    }

    appElement(packageId: string): ElementDefinition | null {
        return this.#found.get(packageId)?.app ?? null;
    }

    /** What running this preview asks of the person now: everything for a first run, only what is new after. `consent: false` = nothing to ask. */
    review(packageId: string): GAppReview {
        const found = this.#found.get(packageId);
        if (!found) throw new Error(`no workspace holds a preview of ${packageId}`);
        const lookup = (id: string) => this.#ports.catalog().get(id);
        const { preview, request } = found;
        const kept = this.#kept[packageId]?.grant ?? null;
        const base = { packageId, name: preview.name, version: preview.version, digest: preview.digest, publisher: preview.publisher };
        if (kept) {
            const r = updateReview(kept, request, lookup);
            if (!r.ok) throw new Error(r.problems.join('; '));
            return { ...base, update: true, consent: r.consent, items: r.consent ? r.items : [] };
        }
        const r = installReview(request, lookup);
        if (!r.ok) throw new Error(r.problems.join('; '));
        return { ...base, update: false, consent: true, items: r.items };
    }

    /** The person's consent, recorded as this preview's own grant. */
    grant(packageId: string, scope: GrantScope): Promise<GAppGrant> {
        return this.#serial(async () => {
            const found = this.#found.get(packageId);
            if (!found) throw new Error(`no workspace holds a preview of ${packageId}`);
            const grant = grantFor(found.request, { scope, now: (this.#ports.now ?? Date.now)() });
            await this.#write({ ...this.#kept, [packageId]: { grant, networkAllowed: this.#kept[packageId]?.networkAllowed ?? false } });
            return grant;
        });
    }

    /** Let an Unverified preview reach its hosts, or take that back. */
    allowNetwork(packageId: string, allowed: boolean): Promise<void> {
        return this.#serial(async () => {
            if (!this.#found.has(packageId) && !this.#kept[packageId]) throw new Error(`no workspace holds a preview of ${packageId}`);
            await this.#write({ ...this.#kept, [packageId]: { grant: this.#kept[packageId]?.grant ?? null, networkAllowed: allowed } });
        });
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #withKept(found: Found): GAppPreview {
        const kept = this.#kept[found.preview.packageId];
        return { ...found.preview, grant: kept?.grant ?? null, networkAllowed: kept?.networkAllowed ?? false };
    }

    async #read(workspace: { id: string; name: string; path: string }): Promise<Found | null> {
        let raw: unknown;
        try {
            raw = JSON.parse(await readFile(join(workspace.path, PACKAGE_MANIFEST_FILE), 'utf8'));
        } catch {
            return null;
        }
        const parsed = declarationOf(raw);
        if (!parsed.ok) return null;
        const app = parsed.declaration.contributions.find((d) => d.kind === 'app')!;
        // Signed as it is now: its publisher. Anything else is the workspace's own work in progress, Unverified.
        const signed = parsed.keyId !== null ? await checkPackage(workspace.path, { keyId: parsed.keyId, keys: this.#ports.keys, publisherChecksOff: false }) : null;
        const verified = signed !== null && signed.decision.install && signed.digest !== null;
        let digest = verified ? signed.digest! : '';
        if (!verified) {
            const now = await currentDigest(workspace.path);
            digest = now.ok ? now.digest : '';
        }
        const publisher = verified ? parsed.keyId! : 'unverified';
        const { id, version } = parsed.declaration;
        return {
            dir: workspace.path, app,
            preview: { packageId: id, name: parsed.name, version, digest, workspaceId: workspace.id, workspaceName: workspace.name, publisher, unverified: !verified },
            request: { packageId: id, version, digest, publisher, uses: Array.isArray(app.payload.uses) ? (app.payload.uses as string[]) : [], network: [...app.permissions.network] },
        };
    }

    async #write(kept: Record<string, Kept>): Promise<void> {
        const file = join(this.#ports.dir, 'previews.json');
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ previews: kept }, null, 2), 'utf8');
        await renameOver(tmp, file);
        this.#kept = kept;
        for (const listener of [...this.#listeners]) listener();
    }

    #serial<T>(work: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(work, work);
        this.#queue = run.then(() => undefined, () => undefined);
        return run;
    }
}
