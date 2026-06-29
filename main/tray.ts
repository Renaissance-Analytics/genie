import {
    app,
    Menu,
    nativeImage,
    NativeImage,
    shell,
    Tray,
    MenuItem,
} from 'electron';
import {
    showSettingsWindow,
    showCaptureWindow,
    showTerminalWindow,
    showMasterWindow,
    openTaskManagerWindow,
} from './background';

let tray: Tray | null = null;
let normalImg: NativeImage | null = null;
let updateImg: NativeImage | null = null;
/** Version string when an update is available; null = no update pending. */
let updateVersion: string | null = null;
/** When the pending update must be downloaded by hand (Linux/macOS where auto-
 *  apply can't run), the release page to open; null for an in-app auto-update. */
let updateManualUrl: string | null = null;

function sized(image: NativeImage): NativeImage {
    return image.isEmpty()
        ? nativeImage.createEmpty()
        : image.resize({ width: 18, height: 18 });
}

export function createTray(image: NativeImage, updateImage?: NativeImage): Tray {
    normalImg = sized(image);
    updateImg = updateImage ? sized(updateImage) : null;
    tray = new Tray(updateVersion && updateImg ? updateImg : normalImg);
    applyTooltip();
    rebuildMenu();
    tray.on('click', () => {
        // Single entry point: the master workspace + terminal surface.
        // The legacy /tray BrowserWindow is no longer surfaced.
        if (process.platform !== 'darwin') showMasterWindow();
    });
    return tray;
}

/**
 * Flip the tray into (or out of) update-available mode: badge icon,
 * tooltip, and a highlighted install entry at the top of the menu.
 * Safe to call before createTray — state is re-applied on creation.
 */
export function setUpdateAvailable(version: string | null, manualUrl: string | null = null): void {
    if (updateVersion === version && updateManualUrl === manualUrl) return;
    updateVersion = version;
    updateManualUrl = manualUrl;
    if (!tray) return;
    if (version && updateImg) tray.setImage(updateImg);
    else if (normalImg) tray.setImage(normalImg);
    applyTooltip();
    rebuildMenu();
}

function applyTooltip(): void {
    tray?.setToolTip(
        updateVersion
            ? `Genie — update v${updateVersion} available`
            : 'Genie — Tynn workspace manager',
    );
}

export function getTray(): Tray | null {
    return tray;
}

/**
 * Kept as a no-op so other modules that still import this symbol don't
 * break their builds during the inbox feature removal. Safe to delete
 * once `setInboxBadge` import sites are all gone.
 */
export function setInboxBadge(_count: number): void {
    /* inbox feature removed — kept as no-op for back-compat */
}

export function rebuildMenu(): void {
    if (!tray) return;

    const items: Array<MenuItem | Electron.MenuItemConstructorOptions> = [];

    if (updateVersion) {
        items.push({
            label: updateManualUrl
                ? `⬆ Download Genie v${updateVersion}…`
                : `⬆ Update to v${updateVersion}…`,
            click: () => {
                // A manual-download update (auto-apply can't run on this build)
                // opens the release page; an auto-update opens Settings to install.
                if (updateManualUrl) void shell.openExternal(updateManualUrl).catch(() => {});
                else showSettingsWindow();
            },
        });
        items.push({ type: 'separator' });
    }

    items.push({
        label: 'Quick capture…',
        accelerator:
            process.platform === 'darwin'
                ? 'Cmd+Shift+W'
                : 'Ctrl+Shift+W',
        click: () => showCaptureWindow(),
    });
    items.push({
        // "TheFloor" is an internal codename — never user-facing.
        label: 'Open Genie',
        click: () => showMasterWindow(),
    });
    items.push({
        label: 'New scratch terminal',
        click: () => showTerminalWindow(),
    });
    items.push({
        label: 'Task Manager…',
        click: () => openTaskManagerWindow(),
    });
    items.push({
        label: 'Check for updates…',
        click: async () => {
            try {
                // Use the ACTIVE backend (electron-updater on a packaged build),
                // not the phase-1 git updater — which can't update a packaged
                // install and silently no-ops, so the tray check looked dead on
                // real builds (the tray is the primary update touchpoint when
                // Genie is tray-resident, e.g. on Linux).
                const { checkForUpdatesNow } = await import('./updater/ipc');
                checkForUpdatesNow(true);
            } catch (e) {
                console.error('updater check failed', e);
            }
            showSettingsWindow();
        },
    });
    items.push({
        label: 'Settings…',
        click: () => showSettingsWindow(),
    });
    items.push({ type: 'separator' });
    items.push({
        label: 'Quit Genie',
        click: () => {
            (app as any).isQuiting = true;
            app.quit();
        },
    });

    tray.setContextMenu(Menu.buildFromTemplate(items));
}
