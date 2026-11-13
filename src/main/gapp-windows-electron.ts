import { BrowserWindow, session, type Session } from 'electron';
import { appSlug } from '../core/gapp-origin.js';
import { bringUp, type ActivationLedger } from '../core/window-activation.js';
import type { GAppSessionsApi } from '../core/gapps.js';
import { GAppWindows } from './gapp-window.js';
import { guardSession, routeSession } from './genie-browser-electron.js';

/**
 * AN APP'S WINDOW IN ELECTRON (Tynn #595). Each app has its own browser session, in memory, shared with no other app and
 * with nothing of Genie's; it keeps no cookies or browser storage after Genie closes (an app's data is its store, V5).
 *
 * THE `.gen` TRUST, the same rules as the Genie Browser's (genie-browser-electron.ts):
 *  - addresses: only `.gen` goes to Genie's front door, by the session's PAC; anything else the app's CSP allows goes out
 *    directly. Chromium has no per-session resolver, so the proxy is the resolver, and it is set before anything loads.
 *  - certificates: a `.gen` certificate is trusted only when Genie's own CA signed it for exactly that name. Nothing is
 *    added to the machine's trust store, and any other address gets Chromium's normal verification.
 *  - every request a page makes is cancelled unless it travels secure.
 * The front door can come back on another port or with another CA: `frontDoor` is read as it is now, and `reroute` follows.
 */
export function gappWindowsElectron(deps: {
    readonly sessions: () => GAppSessionsApi | null;
    readonly frontDoor: () => { readonly port: number; readonly caPem: string | null };
    readonly preload: string;
    readonly ledger: ActivationLedger;
    readonly log?: (line: string) => void;
}): { open(packageId: string, options?: { preview?: boolean }): Promise<void>; reroute(): void } {
    const log = deps.log ?? ((line: string) => console.log(line));
    const sessions = new Map<string, Session>();
    const host = (): GAppSessionsApi => {
        const api = deps.sessions();
        if (!api) throw new Error('Genie\'s host is not connected yet; try again in a moment.');
        return api;
    };
    const windows = new GAppWindows<Session>({
        sessions: { open: async (id, options) => host().open(id, options), close: (token) => { deps.sessions()?.close(token); } },
        caPem: () => deps.frontDoor().caPem,
        prepareSession: async (key) => {
            let ses = sessions.get(key);
            if (!ses) {
                const preview = key.startsWith('preview:');
                const packageId = preview ? key.slice('preview:'.length) : key;
                ses = session.fromPartition(preview ? `gapp-preview-${appSlug(packageId)}` : `gapp-${appSlug(packageId)}`);
                guardSession(ses, () => deps.frontDoor().caPem);
                sessions.set(key, ses);
            }
            await routeSession(ses, deps.frontDoor().port, log);
            return ses;
        },
        create: (options, ses) => new BrowserWindow({ ...options, webPreferences: { ...(options.webPreferences as object), session: ses } }),
        preload: deps.preload,
        bringUp: (win) => { bringUp(win as BrowserWindow, { activation: 'user-gesture', reason: 'GApp window', ledger: deps.ledger, label: 'gapp' }); },
    });
    return {
        open: (packageId, options) => windows.open(packageId, options),
        reroute: () => { for (const ses of sessions.values()) void routeSession(ses, deps.frontDoor().port, log); },
    };
}
