import { join } from 'node:path';
import { isGenHost } from './browser-origins.js';

/**
 * WHERE A WORKSPACE'S LOGINS LIVE, AND WHAT A <webview> MAY BE (the host split, P2b; the owner, 2026-11-03).
 *
 * One store per workspace per process, `<genie home>/browser/<workspace id>/<window|browser>`, kept by `session.fromPath`.
 * Two processes cannot share one (measured on Electron 45.2.2: on Windows the key is in each process's own Local State, on
 * Linux neither sees the other live), so the window's and the browser's are separate and a sync carries `.gen` cookies.
 */

export type BrowserStoreSide = 'window' | 'browser';

/**
 * Measured on omarchy-test: with the cookie fuse on, a launch with no keyring that opens a store destroys what is in it, for
 * good, and availability doesn't update in a running process. So nothing opens a store without the key, and a restart is
 * the way out.
 */
export const STORE_LOCKED = 'Genie sites need your keyring, which isn’t available. Their logins are safe. Unlock it, then restart.';

const WORKSPACE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function browserStorePath(genieHome: string, workspaceId: string, side: BrowserStoreSide): string {
    if (!WORKSPACE_ID.test(workspaceId) || workspaceId === '.' || workspaceId === '..') throw new Error(`not a workspace id for a browser store: ${JSON.stringify(workspaceId)}`);
    return join(genieHome, 'browser', workspaceId, side);
}

/** The preferences Electron hands `will-attach-webview`: what the renderer's attributes asked for, changed in place. */
export type WebviewPrefs = Record<string, unknown>;

export type WebviewAttach = { readonly allow: true; readonly host: string } | { readonly allow: false };

/**
 * May this <webview> attach, and with what. A renderer's attributes choose nothing: every preference that could reach
 * Node, the app or another store is forced, allowed or not, and only an enabled `.gen` site over https loads.
 */
export function guardWebviewAttach(src: string, prefs: WebviewPrefs, options: { readonly enabledHosts: () => readonly string[] }): WebviewAttach {
    for (const key of ['preload', 'preloadURL', 'partition', 'enableBlinkFeatures', 'disableBlinkFeatures']) delete prefs[key];
    Object.assign(prefs, {
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
    });
    let url: URL;
    try { url = new URL(src); } catch { return { allow: false }; }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !isGenHost(host)) return { allow: false };
    return options.enabledHosts().some((h) => h.toLowerCase() === host) ? { allow: true, host } : { allow: false };
}
