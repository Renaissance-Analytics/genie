import {
    app,
    Menu,
    nativeImage,
    NativeImage,
    Tray,
    MenuItem,
} from 'electron';
import {
    showSettingsWindow,
    showCaptureWindow,
    showTerminalWindow,
    showMasterWindow,
} from './background';
import { listWorkspaces } from './db';
import { openWorkspace } from './workspace/open';

let tray: Tray | null = null;
let normalImg: NativeImage | null = null;
let updateImg: NativeImage | null = null;
/** Version string when an update is available; null = no update pending. */
let updateVersion: string | null = null;

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
export function setUpdateAvailable(version: string | null): void {
    if (updateVersion === version) return;
    updateVersion = version;
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

    const workspaces = listWorkspaces();
    const items: Array<MenuItem | Electron.MenuItemConstructorOptions> = [];

    if (updateVersion) {
        items.push({
            label: `⬆ Update to v${updateVersion}…`,
            click: () => showSettingsWindow(),
        });
        items.push({ type: 'separator' });
    }

    if (workspaces.length === 0) {
        items.push({ label: 'No workspaces yet', enabled: false });
    } else {
        items.push({ label: 'Workspaces', enabled: false });
        for (const w of workspaces.slice(0, 12)) {
            items.push({
                label: `  ${w.tynn_project_name}`,
                sublabel: w.shape === 'agi' ? '.agi envelope' : 'simple',
                click: async () => {
                    try {
                        await openWorkspace(w.id);
                    } catch (e) {
                        console.error('Failed to open workspace', e);
                    }
                },
            });
        }
        if (workspaces.length > 12) {
            items.push({
                label: `…and ${workspaces.length - 12} more`,
                click: () => showMasterWindow(),
            });
        }
    }

    items.push({ type: 'separator' });
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
        label: 'Check for updates…',
        click: async () => {
            try {
                const { updater } = await import('./updater/git-updater');
                await updater().checkForUpdate();
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
