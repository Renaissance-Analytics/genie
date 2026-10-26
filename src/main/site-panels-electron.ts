import { WebContentsView, ipcMain, shell, type BrowserWindow } from 'electron';
import { attachPageNavigation } from './page-navigation-electron.js';
import { normalizeNavUrl } from '../core/genie-browser.js';
import { genieBrowserSession } from './genie-browser-electron.js';
import { SitePanelViews, type PanelViewPort } from './site-panel-views.js';
import type { Activation } from '../core/window-activation.js';

/**
 * LIVE SITE PANELS — the Electron half (beta.35 item 36, step 5). Everything decidable is in site-panel-views.ts
 * (tested); this file only touches Electron, and its load-bearing lines are source-checked (test/site-panel-live.test.tsx):
 *
 * - each panel's page is a WebContentsView on the WINDOW the panel is in, placed over the panel's box;
 * - in the Genie browser's own session (`genieBrowserSession`: .gen to the front door, Genie's CA for .gen only, every
 *   request secure or cancelled) — the window's own session has no .gen route;
 * - isolated from Node with no preload, and NOT sandboxed (a sandboxed child view renders blank, electron#44897);
 * - a page's new window opens in the Genie browser window; a link off the Genie sites opens in the machine's browser.
 */

export interface SitePanelsOptions {
    readonly window: BrowserWindow;
    readonly frontDoorPort: number;
    readonly caPem: string | null;
    readonly enabledHosts: () => readonly string[];
    /**
     * The Genie browser window, for a page's new window and the panel's "Open in browser". `activation` (genie#1235): the
     * panel's button is the person's; a page opening a window — its own script, or an agent driving it — is background.
     */
    readonly openInWindow: (url: string, activation: Activation) => void;
}

export function sitePanels(options: SitePanelsOptions): SitePanelViews {
    const { window } = options;
    const createView = (panelKey: string): PanelViewPort => {
        const { ses, routed } = genieBrowserSession({ frontDoorPort: options.frontDoorPort, caPem: options.caPem });
        const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: false } });
        const wc = view.webContents;
        // Agents may drive it (browser rebuild step 7): fancy's navigation script, in an isolated world, on every load.
        const detachPage = attachPageNavigation(`panel:${panelKey}`, wc);
        view.setVisible(false);
        window.contentView.addChildView(view);
        wc.setWindowOpenHandler(({ url }) => {
            options.openInWindow(url, 'background');
            return { action: 'deny' };
        });
        wc.on('will-navigate', (event, url) => {
            if ('url' in normalizeNavUrl(url, new Set(options.enabledHosts()))) return;
            event.preventDefault();
            if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => {});
        });
        return {
            load: (url) => { void (async () => { await routed; await wc.loadURL(url); })().catch(() => {}); },
            reload: () => wc.reload(),
            setBounds: (bounds) => view.setBounds(bounds),
            setVisible: (visible) => view.setVisible(visible),
            destroy: () => {
                detachPage();
                if (!window.isDestroyed()) window.contentView.removeChildView(view);
                if (!wc.isDestroyed()) wc.close();
            },
        };
    };
    const panels = new SitePanelViews({ enabledHosts: options.enabledHosts, createView });

    // The window's calls: only its own (a panel is placed in the window that shows it).
    const ours = (event: { sender: unknown }) => event.sender === window.webContents;
    const key = (raw: unknown) => (typeof raw === 'string' ? raw : '');
    ipcMain.handle('site-panel:show', (event, panelKey: unknown, host: unknown, raw: unknown) => {
        const b = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
        if (!ours(event) || !b || [b.x, b.y, b.width, b.height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return { ok: false, error: 'not a panel of this window' };
        return panels.show(key(panelKey), key(host), { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number });
    });
    ipcMain.handle('site-panel:hide', (event, panelKey: unknown) => { if (ours(event)) panels.hide(key(panelKey)); });
    ipcMain.handle('site-panel:reload', (event, panelKey: unknown) => { if (ours(event)) panels.reload(key(panelKey)); });
    ipcMain.handle('site-panel:open-window', (event, host: unknown) => { if (ours(event)) options.openInWindow(`https://${key(host)}/`, 'user-gesture'); });
    window.on('closed', () => panels.closeAll());
    return panels;
}
