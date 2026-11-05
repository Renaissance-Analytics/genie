import { ipcMain, shell, type BrowserWindow, type WebContents } from 'electron';
import { normalizeNavUrl } from '../core/genie-browser.js';
import type { Activation } from '../core/window-activation.js';
import { workspaceBrowserSession } from './genie-browser-electron.js';
import { attachPageNavigation } from './page-navigation-electron.js';
import { guardSiteWebviews } from './site-webview-guard.js';

/**
 * LIVE SITE PANELS, MAIN'S HALF (the host split, P2b; the owner, 2026-11-03). The page is a <webview> the window keeps in a
 * layer (renderer/site-webview-layer.ts), so no bounds or show cross to main. Main does what must not be the renderer's:
 *
 * - the session is the store of the site's OWN workspace, from main's own list, whatever panel asked;
 * - a site loads only once that store is routed to the front door (a `.gen` load before it would go to DNS);
 * - each main window is guarded as it is built (site-webview-guard.ts);
 * - a guest is driven as any page: fancy's navigation script, in an isolated world, on every load.
 */

export interface SitePanelsOptions {
    /** The main window now; null while there is none (tray-only Genie). */
    readonly window: () => BrowserWindow | null;
    readonly genieHome: string;
    readonly frontDoorPort: number;
    readonly caPem: string | null;
    readonly enabledHosts: () => readonly string[];
    /** The workspace a served site belongs to, or null. */
    readonly workspaceOfHost: (host: string) => string | null;
    /**
     * The Genie browser window, for a page's new window and the panel's "Open in browser". `activation` (genie#1235): the
     * panel's button is the person's; a page opening a window — its own script, or an agent driving it — is background.
     */
    readonly openInWindow: (url: string, activation: Activation) => void;
    /** The host's browser service, for a panel's site in its own window. Null with no host. */
    readonly browserCall: (method: string, args: readonly unknown[]) => Promise<unknown> | null;
}

export interface LiveSitePanels {
    /** A (new) main window: its webviews are guarded from the start. */
    attach(window: BrowserWindow): void;
}

export function sitePanels(options: SitePanelsOptions): LiveSitePanels {
    const storeFor = (host: string) => {
        const workspaceId = options.workspaceOfHost(host);
        return workspaceId === null ? null : workspaceBrowserSession({ genieHome: options.genieHome, workspaceId, side: 'window', frontDoorPort: options.frontDoorPort, caPem: options.caPem });
    };
    // The window's calls: only the main window's own.
    const ours = (event: { sender: unknown }) => { const w = options.window(); return w !== null && !w.isDestroyed() && event.sender === w.webContents; };
    const key = (raw: unknown) => (typeof raw === 'string' ? raw : '');

    ipcMain.handle('site-panel:prepare', async (event, raw: unknown) => {
        if (!ours(event)) return { ok: false, error: 'this is not the main window' };
        const nav = normalizeNavUrl(key(raw), new Set(options.enabledHosts()));
        if ('error' in nav) return { ok: false, error: nav.error };
        const store = storeFor(new URL(nav.url).hostname);
        if (store === null) return { ok: false, error: `${key(raw)} belongs to no workspace here` };
        await store.routed;
        return { ok: true };
    });
    ipcMain.handle('site-panel:pop-out', async (event, panelKey: unknown, host: unknown) => { if (ours(event)) await options.browserCall('popOut', [key(panelKey), key(host)]); });
    ipcMain.handle('site-panel:pop-back', async (event, panelKey: unknown) => { if (ours(event)) await options.browserCall('popBack', [key(panelKey)]); });
    ipcMain.handle('site-panel:popped', async (event) => (ours(event) ? (await options.browserCall('popped', [])) ?? [] : []));
    ipcMain.handle('site-panel:open-window', (event, host: unknown) => { if (ours(event)) options.openInWindow(`https://${key(host)}/`, 'user-gesture'); });

    return {
        attach(window: BrowserWindow): void {
            guardSiteWebviews(window.webContents, {
                enabledHosts: options.enabledHosts,
                sessionForHost: (host) => storeFor(host)?.ses ?? null,
                openInWindow: options.openInWindow,
                storeOf: (url) => { try { return options.workspaceOfHost(new URL(url).hostname.toLowerCase()); } catch { return null; } },
                openExternal: (url) => { void shell.openExternal(url).catch(() => {}); },
                onGuest: (guest: WebContents) => {
                    const detach = attachPageNavigation(`panel:${guest.id}`, guest);
                    guest.once('destroyed', detach);
                },
            });
        },
    };
}
