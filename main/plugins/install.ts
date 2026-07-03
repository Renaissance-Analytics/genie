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
    upsertPluginMarketplace,
    getPluginMarketplace,
    deletePluginMarketplace,
    listPlugins,
    emptyPluginGrants,
    type PluginGrants,
    type PluginSourceType,
} from '../db';
import { disposePlugin } from './registry';

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

/** Shallow-clone a repo into a fresh temp dir; checkout `ref` when given. */
async function cloneToTemp(url: string, ref?: string): Promise<{ dir: string; commit: string }> {
    if (!url.trim()) throw new Error('A repository URL is required.');
    const dir = path.join(cacheDir(), crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    try {
        await simpleGit({ baseDir: cacheDir() }).clone(url, dir, ['--depth', '1']);
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
): InstalledPluginSummary {
    const prior = getPlugin(manifest.id);
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
        integrity: manifest.integrity ?? null,
        publisher_key_id: manifest.publisher?.keyId ?? null,
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

/** Install one plugin from a local folder (a cheap DEV convenience). */
export async function installPluginFromFolder(folder: string): Promise<InstalledPluginSummary> {
    if (!folder?.trim() || !fs.existsSync(folder)) {
        throw new Error('Choose an existing plugin folder.');
    }
    const manifest = readManifestFrom(folder);
    const installPath = materialise(manifest.id, folder);
    return record(manifest, installPath, { type: 'folder', url: folder });
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
        upsertPluginMarketplace({
            id: manifest.id,
            name: manifest.name,
            url,
            ref: ref ?? null,
            official,
            manifest_json: JSON.stringify(manifest),
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
