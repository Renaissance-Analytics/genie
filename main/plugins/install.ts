/**
 * Plugin + marketplace install / lifecycle (Phase 0).
 *
 * Plugins live in git REPOS; they do NOT ship with Genie. The PRIMARY install
 * path is: the user pastes a repo URL → Genie clones it → validates its
 * `genie-plugin.json` → installs from it. A MARKETPLACE is a git repo whose
 * `genie-marketplace.json` INDEXES many plugins; the user adds the marketplace
 * by URL, browses its members, and installs each INDIVIDUALLY. A single-plugin
 * repo is just the degenerate case (install it directly by its URL).
 *
 * Installed bundles live under `<userData>/plugins/<id>/`; the DB row tracks the
 * source repo URL + pinned commit (signing-ready), which marketplace (if any),
 * the enabled flag (fail-closed default OFF), the validated manifest snapshot,
 * and the GRANULAR granted permissions. A local-FOLDER install is kept as a
 * cheap dev convenience.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';
import { simpleGit } from 'simple-git';
import {
    validatePluginManifest,
    validateMarketplaceManifest,
    PLUGIN_MANIFEST_FILENAME,
    MARKETPLACE_MANIFEST_FILENAME,
    type PluginManifest,
    type MarketplaceManifest,
    type MarketplacePluginEntry,
} from './manifest';
import {
    upsertPlugin,
    getPlugin,
    deletePlugin,
    setPluginTrust,
    setPluginEnabled,
    upsertPluginMarketplace,
    getPluginMarketplace,
    deletePluginMarketplace,
    listPlugins,
    emptyPluginGrants,
    type PluginGrants,
    type PluginSourceType,
    type PluginTrustStatus,
} from '../db';
import { disposePlugin } from './registry';
import { BUNDLED_PLUGIN_SOURCES, materialiseBundled, type BundledPluginSource } from './official';
import { computeBundleIntegrity } from './signing';
import { collectBundleFiles } from './bundle-files';
import {
    productionTrustStore,
    evaluateManifestTrust,
    evaluateMarketplaceTrust,
    pluginRowIsSurfaceable,
    type TrustVerdict,
} from './trust';

function pluginsRoot(): string {
    const dir = path.join(app.getPath('userData'), 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cacheDir(): string {
    const dir = path.join(pluginsRoot(), '.cache');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** A folder name safe on every OS for a plugin id (reverse-DNS is path-safe). */
function installDirFor(id: string): string {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(pluginsRoot(), safe);
}

function readManifestFrom(dir: string): PluginManifest {
    const file = path.join(dir, PLUGIN_MANIFEST_FILENAME);
    if (!fs.existsSync(file)) {
        throw new Error(`No ${PLUGIN_MANIFEST_FILENAME} found at the plugin root.`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`${PLUGIN_MANIFEST_FILENAME} is not valid JSON: ${(e as Error).message}`);
    }
    const res = validatePluginManifest(raw);
    if (!res.ok) {
        throw new Error(`Invalid ${PLUGIN_MANIFEST_FILENAME}:\n  - ${res.errors.join('\n  - ')}`);
    }
    return res.manifest;
}

/** Copy a validated plugin folder into its install dir (replacing any prior). */
function materialise(id: string, from: string): string {
    const dest = installDirFor(id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(from, dest, { recursive: true });
    return dest;
}


/**
 * Evaluate a materialised plugin's PROVENANCE: recompute the code integrity and
 * verify the signature against the live trust store. `firstParty` (bundled
 * plugins materialised from Genie's own signed app) short-circuits to trusted.
 */
function evaluateInstalledTrust(manifest: PluginManifest, installPath: string, firstParty: boolean): {
    verdict: TrustVerdict;
    integrity: string;
} {
    const integrity = computeBundleIntegrity(collectBundleFiles(installPath));
    const verdict = evaluateManifestTrust(manifest, productionTrustStore(), {
        recomputedIntegrity: integrity,
        firstParty,
    });
    return { verdict, integrity };
}

/** Shallow-clone a repo into a fresh temp dir; checkout `ref` when given. */
async function cloneToTemp(url: string, ref?: string): Promise<{ dir: string; commit: string }> {
    if (!url.trim()) throw new Error('A repository URL is required.');
    const dir = path.join(cacheDir(), crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    try {
        // Pin `core.autocrlf=false` + `core.eol=lf` on the NEW repo (they take
        // effect before checkout): the working tree must match the repo's
        // canonical bytes so the integrity we recompute equals the one the CI
        // signer produced. Without this, a Windows host with the default
        // `autocrlf=true` would check text files out as CRLF, the hash would
        // diverge from the signer's LF hash, and every official plugin would be
        // (wrongly) refused as tampered on Windows.
        await simpleGit({ baseDir: cacheDir() }).clone(url, dir, [
            '--depth',
            '1',
            '-c',
            'core.autocrlf=false',
            '-c',
            'core.eol=lf',
        ]);
        const git = simpleGit(dir);
        if (ref) await git.checkout(ref);
        const commit = (await git.revparse(['HEAD'])).trim();
        return { dir, commit };
    } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(
            `Clone failed: ${(e as Error).message}. Check the URL and that you have access to the repository.`,
        );
    }
}

export interface InstalledPluginSummary {
    id: string;
    name: string;
    version: string;
    namespace: string;
}

function summaryOf(manifest: PluginManifest): InstalledPluginSummary {
    return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        namespace: manifest.namespace,
    };
}

/**
 * Record a validated, materialised plugin in the DB. Installed DISABLED
 * (fail-closed) — the user enables it explicitly, and the install-time CONSENT
 * modal (§5.3, `consent.ts`) is where declared capabilities are GRANTED. A NEW
 * install therefore starts with NO grants (declared ≠ granted); a re-install /
 * update preserves the grants the user already made.
 */
function record(
    manifest: PluginManifest,
    installPath: string,
    source: {
        type: PluginSourceType;
        url?: string | null;
        ref?: string | null;
        marketplaceId?: string | null;
    },
    firstParty = false,
): InstalledPluginSummary {
    // Provenance FIRST: recompute integrity + evaluate the signature/trust. A
    // signed-but-tampered / wrong-key / bad-signature bundle is UNTRUSTED — refuse
    // to record it at all (fail-closed; a red flag has no legitimate install).
    const { verdict, integrity } = evaluateInstalledTrust(manifest, installPath, firstParty);
    if (verdict.status === 'untrusted') {
        fs.rmSync(installPath, { recursive: true, force: true });
        throw new Error(`Refused to install "${manifest.name}": ${verdict.reason}`);
    }

    const prior = getPlugin(manifest.id);
    // A re-install that changes the trust verdict must NOT silently keep a stale
    // dev-approval: only carry it forward while the plugin is still unsigned.
    const devApproved = verdict.status === 'unsigned' ? (prior?.dev_approved ?? false) : false;
    upsertPlugin({
        id: manifest.id,
        namespace: manifest.namespace,
        name: manifest.name,
        version: manifest.version,
        source_type: source.type,
        source_url: source.url ?? null,
        source_ref: source.ref ?? null,
        install_path: installPath,
        marketplace_id: source.marketplaceId ?? null,
        // Re-install of an already-enabled plugin keeps it enabled; a new install
        // starts DISABLED.
        enabled: prior?.enabled ?? false,
        manifest_json: JSON.stringify(manifest),
        // Declared ≠ granted: a new install grants NOTHING (fail-closed); consent
        // at enable-time (consent.ts) records the user-chosen subset. A re-install
        // keeps the grants already made.
        grants: prior?.grants ?? emptyPluginGrants(),
        // Store the RECOMPUTED integrity (authoritative) + the provenance/trust.
        integrity,
        signature: manifest.signature ?? null,
        publisher_key_id: manifest.publisher?.keyId ?? null,
        trust: verdict.status,
        dev_approved: devApproved,
    });
    // A re-install may change the code path — drop any stale worker.
    disposePlugin(manifest.id);
    return summaryOf(manifest);
}

/** Install one plugin from a git repo URL (the PRIMARY path). */
export async function installPluginFromRepo(
    url: string,
    ref?: string,
    marketplaceId?: string,
): Promise<InstalledPluginSummary> {
    const { dir, commit } = await cloneToTemp(url, ref);
    try {
        const manifest = readManifestFrom(dir);
        const installPath = materialise(manifest.id, dir);
        return record(manifest, installPath, {
            type: marketplaceId ? 'marketplace' : 'repo',
            url,
            ref: ref ?? commit,
            marketplaceId: marketplaceId ?? null,
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Install one plugin from a local folder. Used both for the DEV convenience path
 * (unsigned/developer plugins) and, with `firstParty`, for Genie's own BUNDLED
 * plugins materialised from the signed app — which are trusted by construction.
 */
export async function installPluginFromFolder(
    folder: string,
    firstParty = false,
): Promise<InstalledPluginSummary> {
    if (!folder?.trim() || !fs.existsSync(folder)) {
        throw new Error('Choose an existing plugin folder.');
    }
    const manifest = readManifestFrom(folder);
    const installPath = materialise(manifest.id, folder);
    return record(manifest, installPath, { type: 'folder', url: folder }, firstParty);
}

/** Deterministic, key-sorted JSON so a manifest compare ignores key ORDER. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/** True when a bundled plugin's STORED manifest has drifted from the embedded source. */
function bundledManifestDrifted(storedManifestJson: string, src: BundledPluginSource): boolean {
    let stored: unknown;
    try {
        stored = JSON.parse(storedManifestJson);
    } catch {
        return true; // an unparseable stored manifest → re-materialise the current source
    }
    return canonicalJson(stored) !== canonicalJson(src.manifest);
}

/**
 * Re-install ONE bundled plugin from its CURRENT embedded source through the normal
 * first-party folder-install path. `record()` (via `installPluginFromFolder`)
 * preserves the prior row's `enabled` flag + granted permissions, so a self-heal
 * never silently re-disables or re-prompts. Shared by the startup reconcile and the
 * revalidation invalid-manifest branch.
 */
async function selfHealBundled(id: string): Promise<void> {
    const materialised = materialiseBundled(id);
    await installPluginFromFolder(materialised.path, true);
}

/**
 * STARTUP SELF-HEAL: for every BUNDLED plugin ALREADY installed whose stored
 * manifest/version has drifted from the source Genie now ships, re-materialise +
 * re-install it (preserving `enabled` + grants).
 *
 * This is the ROOT-CAUSE fix for bundled plugins installed before a schema
 * tightening (e.g. `agent.guide` became mandatory when `mcpTools` are present):
 * their stale stored manifest fails validation on the next boot, and without this
 * they would be wrongly refused. Idempotent — a plugin already matching the
 * embedded source is skipped. Runs BEFORE `revalidateAllPluginTrust()` on boot.
 */
export async function reconcileBundledPlugins(): Promise<void> {
    for (const src of BUNDLED_PLUGIN_SOURCES) {
        try {
            const row = getPlugin(src.id);
            if (!row) continue; // not installed → nothing to reconcile
            const srcVersion = typeof src.manifest.version === 'string' ? src.manifest.version : '';
            if (row.version === srcVersion && !bundledManifestDrifted(row.manifest_json, src)) continue;
            await selfHealBundled(src.id);
        } catch {
            /* best-effort per plugin — one failure must not block the others or boot */
        }
    }
}

/**
 * Gate a plugin whose STORED manifest no longer validates. This is NOT a
 * signature/tamper failure — the manifest merely predates a newer schema — so it
 * is reported as `outdated` (a distinct, accurate reason the UI describes as
 * "needs an update"), never the misleading `untrusted`. Fail-closed: an unloadable
 * manifest cannot surface, so it is disabled.
 */
function gateOutdatedManifest(id: string): void {
    const row = getPlugin(id);
    if (!row) return;
    if (row.trust !== 'outdated') setPluginTrust(id, 'outdated', false);
    if (row.enabled) {
        setPluginEnabled(id, false);
        disposePlugin(id);
    }
}

/**
 * Re-evaluate EVERY installed plugin's trust against the CURRENT trust store and
 * update its cached verdict. This is how revocation propagates: remove a signing
 * key (or an unsigned plugin loses its dev-approval) → any plugin that no longer
 * verifies flips to `untrusted`/blocked and is auto-DISABLED (fail-closed). Called
 * at startup and whenever the trust store or Developer Mode changes.
 */
export function revalidateAllPluginTrust(): void {
    const store = productionTrustStore();
    const bundledIds = new Set(BUNDLED_PLUGIN_SOURCES.map((b) => b.id));
    for (const row of listPlugins()) {
        try {
            const parsed = validatePluginManifest(JSON.parse(row.manifest_json));
            if (!parsed.ok) {
                // A FIRST-PARTY bundled plugin can never be "invalid": its stored
                // manifest merely predates a schema tightening. Self-heal it from the
                // embedded source — NEVER punish it as untrusted. The folder-install
                // path does no awaits, so the row is corrected in place here; a rare
                // failure falls back to `outdated` (still never `untrusted`).
                if (bundledIds.has(row.id)) {
                    void selfHealBundled(row.id).catch(() => gateOutdatedManifest(row.id));
                    continue;
                }
                // Third-party: a stored manifest that no longer validates is OUTDATED
                // against a newer schema, not a signature/tamper failure.
                gateOutdatedManifest(row.id);
                continue;
            }
            // Signature-only re-check (code unchanged since install; skip re-hash).
            // First-party bundled plugins stay trusted.
            const firstParty = row.trust === 'trusted' && !row.signature && !row.publisher_key_id;
            const verdict = evaluateManifestTrust(parsed.manifest, store, { firstParty });
            const devApproved = verdict.status === 'unsigned' ? row.dev_approved : false;
            if (verdict.status !== row.trust || devApproved !== row.dev_approved) {
                setPluginTrust(row.id, verdict.status, devApproved);
            }
            // If it can no longer surface, disable it now (instant revoke).
            const refreshed = getPlugin(row.id);
            if (refreshed && refreshed.enabled && !pluginRowIsSurfaceable(refreshed)) {
                setPluginEnabled(row.id, false);
                disposePlugin(row.id);
            }
        } catch {
            /* skip a row that can't be evaluated — leave it as-is (still gated) */
        }
    }
}

/** Uninstall a plugin: tear down its worker, drop the row, delete the bundle. */
export function uninstallPlugin(id: string): void {
    const row = getPlugin(id);
    disposePlugin(id);
    deletePlugin(id);
    if (row) fs.rmSync(row.install_path, { recursive: true, force: true });
    else fs.rmSync(installDirFor(id), { recursive: true, force: true });
}

// --- Marketplaces ------------------------------------------------------------

function readMarketplaceFrom(dir: string): MarketplaceManifest {
    const file = path.join(dir, MARKETPLACE_MANIFEST_FILENAME);
    if (!fs.existsSync(file)) {
        throw new Error(`No ${MARKETPLACE_MANIFEST_FILENAME} found at the marketplace repo root.`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`${MARKETPLACE_MANIFEST_FILENAME} is not valid JSON: ${(e as Error).message}`);
    }
    const res = validateMarketplaceManifest(raw);
    if (!res.ok) {
        throw new Error(`Invalid ${MARKETPLACE_MANIFEST_FILENAME}:\n  - ${res.errors.join('\n  - ')}`);
    }
    return res.manifest;
}

export interface MarketplaceSummary {
    id: string;
    name: string;
    url: string;
    pluginCount: number;
}

/** Add (or refresh) a marketplace by its repo URL; caches its parsed index. */
export async function addMarketplace(
    url: string,
    ref?: string,
    official = false,
): Promise<MarketplaceSummary> {
    const { dir } = await cloneToTemp(url, ref);
    try {
        const manifest = readMarketplaceFrom(dir);
        // Verify the index signature (provenance). An OFFICIAL marketplace MUST be
        // validly signed by a trusted key; a bad signature is refused outright.
        const verdict = evaluateMarketplaceTrust(manifest, productionTrustStore());
        if (verdict.status === 'untrusted') {
            throw new Error(`Refused to add marketplace "${manifest.name}": ${verdict.reason}`);
        }
        if (official && verdict.status !== 'trusted') {
            throw new Error(`Marketplace "${manifest.name}" cannot be OFFICIAL: ${verdict.reason}`);
        }
        upsertPluginMarketplace({
            id: manifest.id,
            name: manifest.name,
            url,
            ref: ref ?? null,
            official,
            manifest_json: JSON.stringify(manifest),
            signature: manifest.signature ?? null,
            publisher_key_id: manifest.publisher?.keyId ?? null,
        });
        return { id: manifest.id, name: manifest.name, url, pluginCount: manifest.plugins.length };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Re-fetch a marketplace's index. */
export async function refreshMarketplace(id: string): Promise<MarketplaceSummary> {
    const row = getPluginMarketplace(id);
    if (!row) throw new Error(`Unknown marketplace "${id}".`);
    return addMarketplace(row.url, row.ref ?? undefined, row.official);
}

/** The member plugins a marketplace lists (from its cached index). */
export function marketplacePlugins(id: string): MarketplacePluginEntry[] {
    const row = getPluginMarketplace(id);
    if (!row?.manifest_json) return [];
    try {
        const res = validateMarketplaceManifest(JSON.parse(row.manifest_json));
        return res.ok ? res.manifest.plugins : [];
    } catch {
        return [];
    }
}

/**
 * Install one member of a marketplace INDIVIDUALLY. A member either lives in its
 * OWN repo (`entry.repo`) or at a subdir of the marketplace repo (`entry.path`).
 */
export async function installMarketplacePlugin(
    marketplaceId: string,
    pluginId: string,
): Promise<InstalledPluginSummary> {
    const row = getPluginMarketplace(marketplaceId);
    if (!row) throw new Error(`Unknown marketplace "${marketplaceId}".`);
    const entry = marketplacePlugins(marketplaceId).find((p) => p.id === pluginId);
    if (!entry) throw new Error(`Marketplace "${row.name}" does not list a plugin "${pluginId}".`);

    if (entry.repo) {
        return installPluginFromRepo(entry.repo, entry.ref, marketplaceId);
    }
    // A subdir of the marketplace repo: clone the marketplace repo, install from
    // the named path.
    const { dir, commit } = await cloneToTemp(row.url, entry.ref ?? row.ref ?? undefined);
    try {
        const sub = path.join(dir, entry.path ?? '.');
        if (!fs.existsSync(sub)) throw new Error(`Marketplace member path "${entry.path}" not found in the repo.`);
        const manifest = readManifestFrom(sub);
        if (manifest.id !== pluginId) {
            throw new Error(`Marketplace member id mismatch: index says "${pluginId}", manifest says "${manifest.id}".`);
        }
        const installPath = materialise(manifest.id, sub);
        return record(manifest, installPath, {
            type: 'marketplace',
            url: row.url,
            ref: entry.ref ?? commit,
            marketplaceId,
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Remove a marketplace (installed member plugins are left in place). */
export function removeMarketplace(id: string): void {
    deletePluginMarketplace(id);
}

/** Diagnostic: which installed plugins came from a given marketplace. */
export function pluginsFromMarketplace(marketplaceId: string): string[] {
    return listPlugins()
        .filter((p) => p.marketplace_id === marketplaceId)
        .map((p) => p.id);
}
