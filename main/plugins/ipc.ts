/**
 * IPC surface for Settings → Plugins (`plugins:*`). Bridges the renderer's
 * Plugins manager to the install / lifecycle + registry logic. Every handler is
 * main-side (the renderer never touches the filesystem or git directly).
 *
 * The management LOGIC lives in `./manage` (Electron-free) so this IPC surface and
 * the remote `/api/desktop/plugins/*` host route share ONE implementation — a
 * remote window manages the HOST's plugins through the very same operations
 * (genie#101). The only handler that stays here in full is `install-folder`: it
 * opens a native folder picker on the machine the user is sitting at, which has no
 * headless-host equivalent.
 */

import { ipcMain, dialog } from 'electron';
import {
    pluginsList,
    pluginsInstallRepo,
    pluginsInstallFolder,
    pluginsEnable,
    pluginsSetGrant,
    pluginsUninstall,
    pluginsMarketplaces,
    pluginsAddMarketplace,
    pluginsRefreshMarketplace,
    pluginsRefreshMarketplaces,
    pluginsRemoveMarketplace,
    pluginsInstallMarketplacePlugin,
    pluginsOfficial,
    pluginsRecipes,
    pluginsInstallBundled,
    pluginsDeveloperMode,
    pluginsSetDeveloperMode,
    pluginsAddTrustedKey,
    pluginsRemoveTrustedKey,
} from './manage';

// Re-exported for back-compat with existing importers of these view types/helpers.
export {
    toView,
    marketplaceView,
    type PluginPermissionView,
    type InstalledPluginView,
    type MarketplaceView,
    type PluginDeveloperModeState,
    type PluginActionResult,
} from './manage';

export function registerPluginsIpc(): void {
    // --- installed plugins ---------------------------------------------------
    ipcMain.handle('plugins:list', () => pluginsList());

    ipcMain.handle('plugins:install-repo', (_e, url: string, ref?: string) => pluginsInstallRepo(url, ref));

    ipcMain.handle('plugins:install-folder', async (_e, folder?: string) => {
        let dir = folder;
        if (!dir) {
            const r = await dialog.showOpenDialog({
                title: 'Choose a plugin folder (with genie-plugin.json)',
                properties: ['openDirectory'],
            });
            if (r.canceled || !r.filePaths[0]) return { ok: false as const, error: 'cancelled' };
            dir = r.filePaths[0];
        }
        return pluginsInstallFolder(dir);
    });

    ipcMain.handle('plugins:enable', (_e, id: string, enabled: boolean) => pluginsEnable(id, enabled));

    ipcMain.handle(
        'plugins:set-grant',
        (_e, id: string, category: 'fs' | 'network' | 'genieApi', key: string, granted: boolean) =>
            pluginsSetGrant(id, category, key, granted),
    );

    ipcMain.handle('plugins:uninstall', (_e, id: string) => pluginsUninstall(id));

    // --- marketplaces --------------------------------------------------------
    ipcMain.handle('plugins:marketplaces', () => pluginsMarketplaces());

    ipcMain.handle('plugins:add-marketplace', (_e, url: string, ref?: string) => pluginsAddMarketplace(url, ref));

    ipcMain.handle('plugins:refresh-marketplace', (_e, id: string) => pluginsRefreshMarketplace(id));

    // Re-read every STALE marketplace index. The renderer calls this when the
    // Marketplaces tab is opened (and with maxAgeMs 0 for an explicit "Refresh
    // all"), which is how a plugin published AFTER a marketplace was added ever
    // becomes visible — nothing else re-clones the index.
    ipcMain.handle('plugins:refresh-marketplaces', (_e, maxAgeMs?: number) => pluginsRefreshMarketplaces(maxAgeMs));

    ipcMain.handle('plugins:remove-marketplace', (_e, id: string) => pluginsRemoveMarketplace(id));

    ipcMain.handle('plugins:install-marketplace-plugin', (_e, marketplaceId: string, pluginId: string) =>
        pluginsInstallMarketplacePlugin(marketplaceId, pluginId),
    );

    // --- official (curated) tab ---------------------------------------------
    ipcMain.handle('plugins:official', () => pluginsOfficial());

    // Launchable recipes for the WizardModal launcher — only from enabled +
    // surfaceable plugins that hold the `recipes` grant (fail-closed).
    ipcMain.handle('plugins:recipes', () => pluginsRecipes());

    ipcMain.handle('plugins:install-bundled', (_e, id: string) => pluginsInstallBundled(id));

    // --- Developer Mode + trusted signing keys (Phase 3) --------------------
    ipcMain.handle('plugins:developer-mode', () => pluginsDeveloperMode());

    ipcMain.handle('plugins:set-developer-mode', (_e, enabled: boolean) => pluginsSetDeveloperMode(enabled));

    ipcMain.handle('plugins:add-trusted-key', (_e, publicKeyPem: string, label?: string) =>
        pluginsAddTrustedKey(publicKeyPem, label),
    );

    ipcMain.handle('plugins:remove-trusted-key', (_e, keyId: string) => pluginsRemoveTrustedKey(keyId));
}
