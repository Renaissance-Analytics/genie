import { guardWebviewAttach, type WebviewPrefs } from '../core/browser-store.js';
import { normalizeNavUrl } from '../core/genie-browser.js';
import type { Activation } from '../core/window-activation.js';

/**
 * A SITE PANEL'S <webview>, AS MAIN DECIDES IT (the host split, P2b). `webviewTag` is on for the main window only, and a
 * renderer's attributes choose nothing: core/browser-store.ts forces every preference, and the session is the store of the
 * site's own workspace, chosen here. Measured on Electron 45.2.2: this guard is what stands between the window's renderer
 * and a chosen preload, a file:// page or another store.
 */

interface Emits {
    on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface SiteGuest extends Emits {
    getURL?(): string;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    stop(): void;
}

export interface SiteWebviewPorts<Store, Guest> {
    readonly enabledHosts: () => readonly string[];
    /** The store of the workspace this site belongs to, or null: refused rather than given a shared one. */
    readonly sessionForHost: (host: string) => Store | null;
    readonly openInWindow: (url: string, activation: Activation) => void;
    readonly openExternal: (url: string) => void;
    readonly onGuest: (guest: Guest) => void;
    /** Which store a site's logins are in. A guest keeps its session for life, so another store goes to the browser. */
    readonly storeOf?: (url: string) => string | null;
}

export function guardSiteWebviews<Store, Guest extends SiteGuest>(contents: Emits, ports: SiteWebviewPorts<Store, Guest>): void {
    const withinTheSites = (url: string): boolean => 'url' in normalizeNavUrl(url, new Set(ports.enabledHosts()));

    contents.on('will-attach-webview', (event: { preventDefault(): void }, prefs: WebviewPrefs, params: Record<string, unknown>) => {
        delete params['allowpopups'];
        const attach = guardWebviewAttach(typeof params['src'] === 'string' ? params['src'] : '', prefs, { enabledHosts: ports.enabledHosts });
        const store = attach.allow ? ports.sessionForHost(attach.host) : null;
        if (store === null) { event.preventDefault(); return; }
        prefs['session'] = store;
    });

    contents.on('did-attach-webview', (_event: unknown, guest: Guest) => {
        guest.setWindowOpenHandler(({ url }) => {
            ports.openInWindow(url, 'background');
            return { action: 'deny' };
        });
        guest.on('will-navigate', (event: { preventDefault(): void }, url: string) => {
            if (withinTheSites(url)) {
                if (ports.storeOf && guest.getURL && ports.storeOf(url) !== ports.storeOf(guest.getURL())) {
                    event.preventDefault();
                    ports.openInWindow(url, 'user-gesture');
                }
                return;
            }
            event.preventDefault();
            if (/^https?:/i.test(url)) ports.openExternal(url);
        });
        // A load the embedder starts (its `src`, its loadURL) raises no will-navigate.
        guest.on('did-start-navigation', (details: { url: string; isMainFrame: boolean }) => {
            if (details.isMainFrame && !withinTheSites(details.url)) guest.stop();
        });
        ports.onGuest(guest);
    });
}
