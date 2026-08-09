/**
 * The plugin-MANAGEMENT operations, factored out of the `plugins:*` IPC handlers
 * so there is ONE implementation of "list / enable / grant / install / …" that
 * both surfaces share:
 *
 *   - the local Settings → Plugins panel, via `plugins/ipc.ts` (Electron IPC), and
 *   - a REMOTE window driving this machine as its HOST, via
 *     `mobile/api.ts` → `/api/desktop/plugins/*` (genie#101).
 *
 * Plugin abilities (MCP tools + recipes) run on the HOST (see `side.ts`), so a
 * remote window must view and manage the HOST's plugin registry — not the empty
 * client-side one it happens to be rendering from. Routing both callers through
 * these functions is what keeps the two paths from diverging (the remote route is
 * not a re-implementation that can rot).
 *
 * The one management action that STAYS client-local is "install from folder": it
 * needs a native folder picker and a path on the machine the user is sitting at,
 * so `ipc.ts` keeps that wrapper and only the `installPluginFromFolder(dir)` call
 * underneath it is shared.
 *
 * PURE of Electron — no `ipcMain`, no `dialog` — so it is unit-testable and safe
 * to import from the headless host route.
 */

import {
    listPlugins,
    getPlugin,
    setPluginEnabled,
    setPluginGrants,
    setSettings,
    getAllSettings,
    listPluginMarketplaces,
    type PluginRow,
    type PluginGrants,
} from '../db';
import { validatePluginManifest, type PluginManifest, type RejectedMarketplaceEntry } from './manifest';
import {
    installPluginFromRepo,
    installMarketplacePlugin as installMarketplacePluginLib,
    uninstallPlugin,
    addMarketplace as addMarketplaceLib,
    removeMarketplace as removeMarketplaceLib,
    refreshMarketplace as refreshMarketplaceLib,
    refreshStaleMarketplaces,
    marketplacePlugins,
    marketplaceIndexIssues,
    installPluginFromFolder,
    revalidateAllPluginTrust,
    type InstalledPluginSummary,
    type MarketplaceSummary,
} from './install';
import { disposePlugin } from './registry';
import { OFFICIAL_PLUGINS, listBundledPlugins, materialiseBundled } from './official';
import { consentAndEnablePlugin } from './consent';
import { listPluginRecipes, type ResolvedPluginRecipe } from './recipes';
import { userTrustedKeys, addUserTrustedKey, removeUserTrustedKey } from './trust';
import { pluginSides, type PluginSides } from './side';

/** One toggleable granular permission for the Settings UI (§12.1). */
export interface PluginPermissionView {
    category: 'fs' | 'network' | 'genieApi';
    key: string;
    label: string;
    granted: boolean;
}

/** The UI shape for one installed plugin. */
export interface InstalledPluginView {
    id: string;
    name: string;
    version: string;
    namespace: string;
    description: string | null;
    enabled: boolean;
    sourceType: PluginRow['source_type'];
    sourceUrl: string | null;
    marketplaceId: string | null;
    publisher: string | null;
    /** Namespaced tool names (as an agent sees them). */
    tools: Array<{ name: string; description: string }>;
    /** Declared editor file-type → Fancy mappings (§12.2). */
    editors: Array<{ id: string; title: string; extensions: string[]; fancyEditor: string }>;
    /**
     * WHERE this plugin's surfaces run (`side.ts`). `host` is what the enable
     * toggle + permissions below actually govern; a `client`-only plugin runs no
     * code on this machine and needs no permissions here.
     */
    sides: PluginSides;
    /** The granular declared permissions + whether each is granted. */
    permissions: PluginPermissionView[];
    /** Signing-ready provenance surfaced in the UI. */
    integrity: string | null;
    signed: boolean;
    /** Trust verdict (Phase 3): trusted / unsigned / untrusted. */
    trust: PluginRow['trust'];
    /** The signing key id this plugin's signature verifies against (if any). */
    publisherKeyId: string | null;
    /** User knowingly enabled this UNSIGNED plugin under Developer Mode. */
    devApproved: boolean;
}

export interface MarketplaceView {
    id: string;
    name: string;
    url: string;
    official: boolean;
    /** ISO timestamp of the last successful index read — the list's real age. */
    checkedAt: string;
    plugins: Array<{ id: string; name: string; description: string | null; installed: boolean }>;
    /** Members the index lists that Genie cannot install (surfaced, not dropped). */
    issues: RejectedMarketplaceEntry[];
}

/** The Developer-Mode + trusted-key state the Settings panel shows. */
export interface PluginDeveloperModeState {
    enabled: boolean;
    keys: Array<{ keyId: string; label?: string }>;
}

export type PluginActionResult<T = { id: string; name: string; version: string }> =
    | { ok: true; value: T }
    | { ok: false; error: string };

function ok<T>(value: T): { ok: true; value: T } {
    return { ok: true, value };
}
function fail(error: string): { ok: false; error: string } {
    return { ok: false, error };
}

function manifestOf(row: PluginRow): PluginManifest | null {
    try {
        const res = validatePluginManifest(JSON.parse(row.manifest_json));
        return res.ok ? res.manifest : null;
    } catch {
        return null;
    }
}

function permissionViews(manifest: PluginManifest, grants: PluginGrants): PluginPermissionView[] {
    const out: PluginPermissionView[] = [];
    const caps = manifest.capabilities;
    if (caps?.fs && caps.fs.scope !== 'none') {
        const exts = caps.fs.extensions?.length ? ` (${caps.fs.extensions.join(', ')})` : '';
        out.push({
            category: 'fs',
            key: caps.fs.scope,
            label: `Files: ${caps.fs.scope}${exts}`,
            granted: grants.fs[caps.fs.scope] === true,
        });
    }
    for (const host of caps?.network?.hosts ?? []) {
        out.push({ category: 'network', key: host, label: `Network: ${host}`, granted: grants.network[host] === true });
    }
    for (const api of caps?.genieApi ?? []) {
        out.push({ category: 'genieApi', key: api, label: `Genie API: ${api}`, granted: grants.genieApi[api] === true });
    }
    return out;
}

export function toView(row: PluginRow): InstalledPluginView {
    const manifest = manifestOf(row);
    return {
        id: row.id,
        name: row.name,
        version: row.version,
        namespace: row.namespace,
        description: manifest?.description ?? null,
        enabled: row.enabled,
        sourceType: row.source_type,
        sourceUrl: row.source_url,
        marketplaceId: row.marketplace_id,
        publisher: manifest?.publisher?.name ?? null,
        tools: (manifest?.mcpTools ?? []).map((t) => ({
            name: `${row.namespace}.${t.name}`,
            description: t.description,
        })),
        editors: (manifest?.editors ?? []).map((e) => ({
            id: e.id,
            title: e.title,
            extensions: e.extensions,
            fancyEditor: `${e.fancyEditor.package}@${e.fancyEditor.version}#${e.fancyEditor.export}`,
        })),
        sides: manifest ? pluginSides(manifest) : { client: false, host: false },
        // Permissions gate the plugin's HOST code only (see `sides`) — a client-side
        // editor's file access is sandboxed per-read, not by a stored grant.
        permissions: manifest && pluginSides(manifest).host ? permissionViews(manifest, row.grants) : [],
        integrity: row.integrity,
        signed: !!row.signature && !!row.publisher_key_id,
        trust: row.trust,
        publisherKeyId: row.publisher_key_id,
        devApproved: row.dev_approved,
    };
}

export function marketplaceView(id: string): MarketplaceView | null {
    const rows = listPluginMarketplaces();
    const row = rows.find((m) => m.id === id);
    if (!row) return null;
    const installedIds = new Set(listPlugins().map((p) => p.id));
    return {
        id: row.id,
        name: row.name,
        url: row.url,
        official: row.official,
        checkedAt: row.updated_at,
        plugins: marketplacePlugins(id).map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description ?? null,
            installed: installedIds.has(p.id),
        })),
        issues: marketplaceIndexIssues(id),
    };
}

// --- installed plugins -------------------------------------------------------

export function pluginsList(): InstalledPluginView[] {
    return listPlugins().map(toView);
}

export async function pluginsInstallRepo(
    url: string,
    ref?: string,
): Promise<PluginActionResult<InstalledPluginSummary>> {
    try {
        const s = await installPluginFromRepo(String(url ?? '').trim(), ref?.trim() || undefined);
        return ok(s);
    } catch (e) {
        return fail((e as Error).message);
    }
}

/** Shared install-from-folder core; the picker that resolves `dir` stays in `ipc.ts`. */
export async function pluginsInstallFolder(dir: string): Promise<PluginActionResult<InstalledPluginSummary>> {
    try {
        const s = await installPluginFromFolder(dir);
        return ok(s);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function pluginsEnable(id: string, enabled: boolean): Promise<PluginActionResult<boolean>> {
    try {
        const row = getPlugin(String(id));
        if (!row) return fail('unknown plugin');
        if (enabled === true) {
            // Enabling routes through the install-time CONSENT gate (§5.3): it
            // presents the plugin's DECLARED capabilities, records only the
            // GRANTED subset, and enables. A dismissed modal enables nothing.
            const r = await consentAndEnablePlugin(row.id);
            return r.ok ? ok(true) : fail(r.error ?? 'Enabling was cancelled.');
        }
        setPluginEnabled(row.id, false);
        disposePlugin(row.id); // disable = instant fail-closed revoke
        return ok(true);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export function pluginsSetGrant(
    id: string,
    category: 'fs' | 'network' | 'genieApi',
    key: string,
    granted: boolean,
): PluginActionResult<boolean> {
    try {
        const row = getPlugin(String(id));
        if (!row) return fail('unknown plugin');
        const grants = row.grants;
        if (category !== 'fs' && category !== 'network' && category !== 'genieApi') {
            return fail('unknown permission category');
        }
        grants[category][String(key)] = granted === true;
        setPluginGrants(row.id, grants);
        // A grant change invalidates the running worker's cached authority.
        disposePlugin(row.id);
        return ok(true);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export function pluginsUninstall(id: string): PluginActionResult<boolean> {
    try {
        uninstallPlugin(String(id));
        return ok(true);
    } catch (e) {
        return fail((e as Error).message);
    }
}

// --- marketplaces ------------------------------------------------------------

export function pluginsMarketplaces(): MarketplaceView[] {
    return listPluginMarketplaces()
        .map((m) => marketplaceView(m.id))
        .filter((m): m is MarketplaceView => m !== null);
}

export async function pluginsAddMarketplace(
    url: string,
    ref?: string,
): Promise<PluginActionResult<MarketplaceSummary>> {
    try {
        const s = await addMarketplaceLib(String(url ?? '').trim(), ref?.trim() || undefined);
        return ok(s);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function pluginsRefreshMarketplace(id: string): Promise<PluginActionResult<MarketplaceSummary>> {
    try {
        const s = await refreshMarketplaceLib(String(id));
        return ok(s);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function pluginsRefreshMarketplaces(
    maxAgeMs?: number,
): Promise<PluginActionResult<Awaited<ReturnType<typeof refreshStaleMarketplaces>>>> {
    try {
        const reports = await refreshStaleMarketplaces(
            typeof maxAgeMs === 'number' && maxAgeMs >= 0 ? maxAgeMs : undefined,
        );
        return ok(reports);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export function pluginsRemoveMarketplace(id: string): PluginActionResult<boolean> {
    try {
        removeMarketplaceLib(String(id));
        return ok(true);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function pluginsInstallMarketplacePlugin(
    marketplaceId: string,
    pluginId: string,
): Promise<PluginActionResult> {
    try {
        const s = await installMarketplacePluginLib(String(marketplaceId), String(pluginId));
        return ok(s);
    } catch (e) {
        return fail((e as Error).message);
    }
}

// --- official (curated) + bundled -------------------------------------------

export function pluginsOfficial(): { curated: typeof OFFICIAL_PLUGINS; bundled: ReturnType<typeof listBundledPlugins> } {
    // The curated + signed remote list is Phase 3 (empty until then); what Genie
    // ships in the box are the BUNDLED plugins (Hello World + Presentation +
    // Spreadsheet), materialised on demand.
    let bundled: ReturnType<typeof listBundledPlugins> = [];
    try {
        bundled = listBundledPlugins();
    } catch {
        bundled = [];
    }
    return { curated: OFFICIAL_PLUGINS, bundled };
}

/** Launchable recipes for the WizardModal launcher — enabled + `recipes`-granted only. */
export function pluginsRecipes(): ResolvedPluginRecipe[] {
    return listPluginRecipes();
}

export async function pluginsInstallBundled(id: string): Promise<PluginActionResult> {
    try {
        const src = materialiseBundled(String(id));
        // Bundled plugins are FIRST-PARTY (materialised from Genie's own signed
        // app bundle) → trusted by construction.
        const s = await installPluginFromFolder(src.path, true);
        return ok(s);
    } catch (e) {
        return fail((e as Error).message);
    }
}

// --- Developer Mode + trusted signing keys (Phase 3) ------------------------

export function pluginsDeveloperMode(): PluginDeveloperModeState {
    return {
        enabled: getAllSettings().plugins_developer_mode === 'on',
        keys: userTrustedKeys().map((k) => ({ keyId: k.keyId, label: k.label })),
    };
}

export function pluginsSetDeveloperMode(enabled: boolean): PluginActionResult<boolean> {
    try {
        setSettings({ plugins_developer_mode: enabled === true ? 'on' : 'off' });
        // A trust-policy change re-evaluates every plugin (turning dev mode OFF must
        // instantly stop unsigned plugins surfacing — fail-closed).
        revalidateAllPluginTrust();
        return ok(true);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export function pluginsAddTrustedKey(publicKeyPem: string, label?: string): PluginActionResult<{ keyId: string }> {
    try {
        const keyId = addUserTrustedKey(String(publicKeyPem ?? ''), label?.toString());
        revalidateAllPluginTrust(); // a newly-trusted key may promote plugins
        return ok({ keyId });
    } catch (e) {
        return fail((e as Error).message);
    }
}

export function pluginsRemoveTrustedKey(keyId: string): PluginActionResult<boolean> {
    try {
        removeUserTrustedKey(String(keyId));
        // Removing a key REVOKES: any plugin that verified against it flips to
        // untrusted + is auto-disabled.
        revalidateAllPluginTrust();
        return ok(true);
    } catch (e) {
        return fail((e as Error).message);
    }
}
