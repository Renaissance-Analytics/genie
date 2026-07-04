/**
 * IPC surface for Settings → Plugins (`plugins:*`). Bridges the renderer's
 * Plugins manager to the install / lifecycle + registry logic. Every handler is
 * main-side (the renderer never touches the filesystem or git directly).
 */

import { ipcMain, dialog } from 'electron';
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
import { validatePluginManifest, type PluginManifest } from './manifest';
import {
    installPluginFromRepo,
    installPluginFromFolder,
    installMarketplacePlugin,
    uninstallPlugin,
    addMarketplace,
    removeMarketplace,
    refreshMarketplace,
    marketplacePlugins,
    revalidateAllPluginTrust,
} from './install';
import { disposePlugin } from './registry';
import { OFFICIAL_PLUGINS, listBundledPlugins, materialiseBundled } from './official';
import { consentAndEnablePlugin } from './consent';
import { userTrustedKeys, addUserTrustedKey, removeUserTrustedKey } from './trust';

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

function toView(row: PluginRow): InstalledPluginView {
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
        permissions: manifest ? permissionViews(manifest, row.grants) : [],
        integrity: row.integrity,
        signed: !!row.signature && !!row.publisher_key_id,
        trust: row.trust,
        publisherKeyId: row.publisher_key_id,
        devApproved: row.dev_approved,
    };
}

export interface MarketplaceView {
    id: string;
    name: string;
    url: string;
    official: boolean;
    plugins: Array<{ id: string; name: string; description: string | null; installed: boolean }>;
}

function marketplaceView(id: string): MarketplaceView | null {
    const rows = listPluginMarketplaces();
    const row = rows.find((m) => m.id === id);
    if (!row) return null;
    const installedIds = new Set(listPlugins().map((p) => p.id));
    return {
        id: row.id,
        name: row.name,
        url: row.url,
        official: row.official,
        plugins: marketplacePlugins(id).map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description ?? null,
            installed: installedIds.has(p.id),
        })),
    };
}

function ok<T>(value: T): { ok: true; value: T } {
    return { ok: true, value };
}
function fail(error: string): { ok: false; error: string } {
    return { ok: false, error };
}

export function registerPluginsIpc(): void {
    // --- installed plugins ---------------------------------------------------
    ipcMain.handle('plugins:list', () => listPlugins().map(toView));

    ipcMain.handle('plugins:install-repo', async (_e, url: string, ref?: string) => {
        try {
            const s = await installPluginFromRepo(String(url ?? '').trim(), ref?.trim() || undefined);
            return ok(s);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    ipcMain.handle('plugins:install-folder', async (_e, folder?: string) => {
        try {
            let dir = folder;
            if (!dir) {
                const r = await dialog.showOpenDialog({
                    title: 'Choose a plugin folder (with genie-plugin.json)',
                    properties: ['openDirectory'],
                });
                if (r.canceled || !r.filePaths[0]) return fail('cancelled');
                dir = r.filePaths[0];
            }
            const s = await installPluginFromFolder(dir);
            return ok(s);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    ipcMain.handle('plugins:enable', async (_e, id: string, enabled: boolean) => {
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
    });

    ipcMain.handle(
        'plugins:set-grant',
        (_e, id: string, category: 'fs' | 'network' | 'genieApi', key: string, granted: boolean) => {
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
        },
    );

    ipcMain.handle('plugins:uninstall', (_e, id: string) => {
        try {
            uninstallPlugin(String(id));
            return ok(true);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    // --- marketplaces --------------------------------------------------------
    ipcMain.handle('plugins:marketplaces', () =>
        listPluginMarketplaces().map((m) => marketplaceView(m.id)).filter((m): m is MarketplaceView => m !== null),
    );

    ipcMain.handle('plugins:add-marketplace', async (_e, url: string, ref?: string) => {
        try {
            const s = await addMarketplace(String(url ?? '').trim(), ref?.trim() || undefined);
            return ok(s);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    ipcMain.handle('plugins:refresh-marketplace', async (_e, id: string) => {
        try {
            const s = await refreshMarketplace(String(id));
            return ok(s);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    ipcMain.handle('plugins:remove-marketplace', (_e, id: string) => {
        try {
            removeMarketplace(String(id));
            return ok(true);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    ipcMain.handle('plugins:install-marketplace-plugin', async (_e, marketplaceId: string, pluginId: string) => {
        try {
            const s = await installMarketplacePlugin(String(marketplaceId), String(pluginId));
            return ok(s);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    // --- official (curated) tab ---------------------------------------------
    ipcMain.handle('plugins:official', () => {
        // The curated + signed remote list is Phase 3 (empty until then); what
        // Genie ships in the box are the BUNDLED plugins (Hello World +
        // Presentation + Spreadsheet), materialised on demand.
        let bundled: ReturnType<typeof listBundledPlugins> = [];
        try {
            bundled = listBundledPlugins();
        } catch {
            bundled = [];
        }
        return { curated: OFFICIAL_PLUGINS, bundled };
    });

    ipcMain.handle('plugins:install-bundled', async (_e, id: string) => {
        try {
            const src = materialiseBundled(String(id));
            // Bundled plugins are FIRST-PARTY (materialised from Genie's own signed
            // app bundle) → trusted by construction.
            const s = await installPluginFromFolder(src.path, true);
            return ok(s);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    // --- Developer Mode + trusted signing keys (Phase 3) --------------------
    ipcMain.handle('plugins:developer-mode', () => ({
        enabled: getAllSettings().plugins_developer_mode === 'on',
        keys: userTrustedKeys().map((k) => ({ keyId: k.keyId, label: k.label })),
    }));

    ipcMain.handle('plugins:set-developer-mode', (_e, enabled: boolean) => {
        try {
            setSettings({ plugins_developer_mode: enabled === true ? 'on' : 'off' });
            // A trust-policy change re-evaluates every plugin (turning dev mode OFF
            // must instantly stop unsigned plugins surfacing — fail-closed).
            revalidateAllPluginTrust();
            return ok(true);
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    ipcMain.handle('plugins:add-trusted-key', (_e, publicKeyPem: string, label?: string) => {
        try {
            const keyId = addUserTrustedKey(String(publicKeyPem ?? ''), label?.toString());
            revalidateAllPluginTrust(); // a newly-trusted key may promote plugins
            return ok({ keyId });
        } catch (e) {
            return fail((e as Error).message);
        }
    });

    ipcMain.handle('plugins:remove-trusted-key', (_e, keyId: string) => {
        try {
            removeUserTrustedKey(String(keyId));
            // Removing a key REVOKES: any plugin that verified against it flips to
            // untrusted + is auto-disabled.
            revalidateAllPluginTrust();
            return ok(true);
        } catch (e) {
            return fail((e as Error).message);
        }
    });
}
