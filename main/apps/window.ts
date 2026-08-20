/**
 * The GApp window (Tynn #250).
 *
 * A GApp's front end is ordinary web content served from its own `<slug>.gen`
 * origin by Genie's existing hosting — the same path every other site takes — and
 * shown here in a window whose isolation is decided in `window-policy.ts` and
 * asserted in tests. This file is the Electron wiring around those decisions, plus
 * the runtime guards that have no pure form: what happens when the page tries to
 * navigate, open a window, or ask for the microphone.
 *
 * Everything here fails closed. A permission Genie has not thought about is
 * denied, not passed through.
 */

import path from 'path';
import { BrowserWindow, shell } from 'electron';
import { registerAppWindow, windowIdsForApp } from './bridge';
import {
    APP_PRELOAD_FILENAME,
    appWindowOptions,
    decideAppNavigation,
} from './window-policy';

export interface OpenAppWindowOpts {
    appId: string;
    slug: string;
    name: string;
    /** `https://<slug>.gen/` — where Genie serves this app. */
    homeUrl: string;
}

const openWindows = new Map<string, BrowserWindow>();

export function openAppWindow(opts: OpenAppWindowOpts): BrowserWindow {
    const existing = openWindows.get(opts.appId);
    if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return existing;
    }

    const win = new BrowserWindow({
        ...appWindowOptions({ id: opts.appId, slug: opts.slug }, path.join(__dirname, APP_PRELOAD_FILENAME)),
        title: `${opts.name} — Genie App`,
    });

    registerAppWindow(win.webContents, opts.appId);
    openWindows.set(opts.appId, win);
    win.on('closed', () => openWindows.delete(opts.appId));

    // In-window navigation: same origin only. Anything else is either opened in
    // the user's real browser (a plain web link) or refused outright.
    win.webContents.on('will-navigate', (event, url) => {
        const decision = decideAppNavigation(opts.homeUrl, url);
        if (decision.allow) return;
        event.preventDefault();
        if (decision.openExternally) void shell.openExternal(url);
    });

    // `window.open` / target=_blank never gets a second app window — a child
    // window would inherit this one's partition and preload.
    win.webContents.setWindowOpenHandler(({ url }) => {
        const decision = decideAppNavigation(opts.homeUrl, url);
        if (decision.openExternally) void shell.openExternal(url);
        return { action: 'deny' };
    });

    // Camera, microphone, screen capture, location, notifications: an app asks
    // Genie for what it needs through the bridge, where there is a grant to check.
    // Chromium's own permission surface has no such grant behind it, so nothing
    // gets through it.
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
    );
    win.webContents.session.setPermissionCheckHandler(() => false);

    void win.loadURL(opts.homeUrl);
    win.once('ready-to-show', () => win.show());
    return win;
}

/**
 * Close every window an app has open.
 *
 * Called on revoke and on uninstall: a revoked app whose window stayed up would
 * keep showing a live surface whose every action now fails, which reads as broken
 * rather than as revoked.
 */
export function closeAppWindows(appId: string): void {
    const win = openWindows.get(appId);
    if (win && !win.isDestroyed()) win.close();
    openWindows.delete(appId);
    for (const wcId of windowIdsForApp(appId)) {
        const other = BrowserWindow.getAllWindows().find((w) => w.webContents.id === wcId);
        if (other && !other.isDestroyed()) other.close();
    }
}
