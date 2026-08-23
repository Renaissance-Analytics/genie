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
import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import { registerAppWindow, windowIdsForApp } from './bridge';
import { attachAppTabViews, appViewBounds, type AttachedAppView } from './app-views';
import { appWindowTabs } from './window-tabs';
import { gappWindowTitle } from './window-title';
import { ensureAppAgentPanels, registerAppShell, unregisterAppShell } from './ipc';
import type { AppManifest } from './manifest';
import {
    APP_PRELOAD_FILENAME,
    appPartitionFor,
    appWindowOptions,
    decideAppNavigation,
} from './window-policy';

export interface OpenAppWindowOpts {
    appId: string;
    slug: string;
    name: string;
    /** `https://<slug>.gen/` — where Genie serves this app. */
    homeUrl: string;
    /** The app is being BUILT here: dev tools on, and the title says so. */
    devMode?: boolean;
    /** The app's manifest — what its tabs and panels are. */
    manifest?: AppManifest;
    /**
     * Run when this window is gone.
     *
     * A PREVIEW is the caller that needs it: closing its window is the whole
     * cleanup, so something has to remove the throwaway workspace, the panels and
     * the site the moment the window goes. It is a callback rather than a
     * `preview` flag on purpose — this module knows about windows, and teaching it
     * what a preview is would put the teardown rules in the one file that has no
     * way to test them.
     */
    onClosed?: () => void;
}


/** The tab strip Genie draws, in CSS pixels. Views sit beneath it. */
const TAB_STRIP_HEIGHT = 40;

/** Everything open for one app: the Genie shell, and the app's own tab views. */
interface OpenApp {
    window: BrowserWindow;
    views: AttachedAppView<WebContentsView>[];
    active: number;
    /** For the title — see {@link retitle}. */
    appName: string;
}

/**
 * `[{GApp Name}] - {the page's own title}` (owner, 2026-08-22).
 *
 * The prefix GROUPS an app's windows: one GApp gets one window per hosted site, so
 * `[Trader]` on each is what says they are one app. The suffix is the page's own
 * title, live — which means it has to be re-applied on navigation, not set once.
 *
 * Index 0 in the strip is the Agent tab, which is GENIE'S renderer and has no page
 * of its own. It gets the prefix alone: an app's page title has nothing to do with
 * a tab the app cannot draw.
 *
 * The formatting — including refusing a "title" that is really a URL, which is
 * what Chromium hands a page with no `<title>` — is decided in `window-title.ts`
 * and asserted there.
 */
function retitle(open: OpenApp): void {
    if (open.window.isDestroyed()) return;
    const attached = open.views[open.active - 1];
    const wc = attached?.view.webContents;
    open.window.setTitle(
        gappWindowTitle(open.appName, wc && !wc.isDestroyed() ? wc.getTitle() : ''),
    );
}

const openApps = new Map<string, OpenApp>();

/**
 * Lay the active view out beneath the strip, and hide the rest.
 *
 * Hiding is done by BOUNDS rather than by detaching: an app tab that is merely off
 * screen keeps its page alive, so switching back is instant and a dev server's
 * websocket does not reconnect every time somebody looks at the Agent tab.
 */
function layout(open: OpenApp): void {
    const { width, height } = open.window.getContentBounds();
    open.views.forEach((attached, i) => {
        // Index 0 in the STRIP is the Agent tab, which has no view — so view `i`
        // is tab `i + 1`.
        const visible = open.active === i + 1;
        attached.view.setBounds(
            visible
                ? appViewBounds({ width, height }, TAB_STRIP_HEIGHT)
                : { x: 0, y: 0, width: 0, height: 0 },
        );
    });
}

/**
 * The webContents of an app's embedded views.
 *
 * Exported for the E2E: the isolation claims are about the surface running the
 * app's code, and after the App Tray pivot that is a view inside Genie's window
 * rather than the window itself. A spec asserting them against the shell would be
 * asserting them against Genie's own renderer, and passing for the wrong reason.
 */
export function appViewWebContents(appId: string): Electron.WebContents[] {
    return (openApps.get(appId)?.views ?? []).map((v) => v.view.webContents);
}

/** Show tab `index` from the strip (0 is the Agent tab, which is the shell itself). */
export function showAppTab(appId: string, index: number): void {
    const open = openApps.get(appId);
    if (!open || open.window.isDestroyed()) return;
    open.active = index;
    layout(open);
    // The window is named after whatever tab is showing, so switching renames it.
    retitle(open);
}


export function openAppWindow(opts: OpenAppWindowOpts): BrowserWindow {
    const existing = openApps.get(opts.appId);
    if (existing && !existing.window.isDestroyed()) {
        existing.window.show();
        existing.window.focus();
        return existing.window;
    }

    // The panels the manifest declared, laid out BEFORE the shell loads, so the
    // Agent tab's first read of the workspace already has them and nothing has to
    // be pushed in afterwards. It tops the workspace up to what the app asked for
    // and creates nothing when that is already true — a GApp's panels are
    // workspace state, so a seed that ran unconditionally would leave a user three
    // more terminals every time they clicked the app's pill.
    if (opts.manifest) ensureAppAgentPanels(opts.appId, opts.manifest.panels);

    // GENIE'S window, running Genie's own renderer — NOT the app's. The frame, the
    // tab strip and the Agent tab belong to Genie, which is what makes "am I
    // looking at Genie or at the app?" answerable at a glance instead of by
    // trusting what is painted. The app's surfaces are embedded views below.
    //
    // It therefore takes Genie's normal preload and is NEVER registered with the
    // bridge: registering it would hand the app's grant to a webContents holding
    // the entire desktop API.
    const win = new BrowserWindow({
        width: 1100,
        height: 780,
        minWidth: 480,
        minHeight: 360,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#0a0a0c',
        // The prefix alone until a hosted page says otherwise. It never says
        // "Genie App" and never carries an address: the window is technically a
        // browser and none of its chrome may read as one.
        title: gappWindowTitle(opts.name, ''),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    registerAppShell(win.webContents.id, opts.appId);

    // The SHELL's own document.title must never reach the window. Electron applies
    // a loaded page's title by default, and this page is Genie's renderer — so
    // without this the window would be named by Genie's own markup instead of by
    // the app, and `[Trader] - Positions` would be overwritten a frame after it
    // was set.
    win.webContents.on('page-title-updated', (event) => event.preventDefault());

    const open: OpenApp = { window: win, views: [], active: 0, appName: opts.name };
    openApps.set(opts.appId, open);
    win.on('closed', () => {
        unregisterAppShell(win.webContents.id);
        openApps.delete(opts.appId);
        // AFTER the bookkeeping above, so a teardown that reaches back in here —
        // a preview's does, to close whatever else the app has open — finds this
        // window already gone rather than recursing into it.
        opts.onClosed?.();
    });
    win.on('resize', () => layout(open));

    // The app's OWN tabs, each an embedded view with the app's preload, partition
    // and sandbox — and each registered with the bridge, which the shell is not.
    if (opts.manifest) {
        open.views = attachAppTabViews<WebContentsView>(
            opts.manifest,
            appWindowTabs(opts.manifest),
            {
                makeView: (prefs) => {
                    const view = new WebContentsView({ webPreferences: prefs });
                    win.contentView.addChildView(view);
                    return view;
                },
                register: (view, appId) => registerAppWindow(view.webContents, appId),
                loadURL: (view, url) => void view.webContents.loadURL(url),
                guardNavigation: (view, homeUrl) => guardViewNavigation(view, homeUrl),
                preloadPath: path.join(__dirname, APP_PRELOAD_FILENAME),
            },
            { devMode: opts.devMode === true },
        );
        // LIVE, not once. A single-page app changes its title by navigating
        // in-page, and a title set at load would go stale the moment the user
        // clicked anything — which is the failure that makes a window title
        // useless rather than merely wrong.
        for (const attached of open.views) {
            attached.view.webContents.on('page-title-updated', (event) => {
                // Genie owns this window's chrome, so the page does not get to
                // set the title directly — it gets to inform ours.
                event.preventDefault();
                retitle(open);
            });
        }
        layout(open);
        retitle(open);
    }

    void win.loadURL(shellUrl());
    win.once('ready-to-show', () => win.show());
    return win;
}

/** Genie's own page for a GApp window — the strip and the Agent tab. */
function shellUrl(): string {
    return process.env.NODE_ENV === 'production'
        ? `file://${path.join(__dirname, 'gapp.html')}`
        : 'http://localhost:8888/gapp';
}

/**
 * The navigation and permission rules for ONE embedded app view.
 *
 * Applied per view rather than per window, because the window is Genie's now: the
 * rules have to travel with the surface running the app's code, or they guard
 * nothing that matters.
 */
function guardViewNavigation(view: WebContentsView, homeUrl: string): void {
    view.webContents.on('will-navigate', (event, url) => {
        const decision = decideAppNavigation(homeUrl, url);
        if (decision.allow) return;
        event.preventDefault();
        if (decision.openExternally) void shell.openExternal(url);
    });

    // `window.open` / target=_blank never gets a window of its own — a child would
    // inherit this view's partition and preload.
    view.webContents.setWindowOpenHandler(({ url }) => {
        const decision = decideAppNavigation(homeUrl, url);
        if (decision.openExternally) void shell.openExternal(url);
        return { action: 'deny' };
    });

    // Camera, microphone, screen capture, location: an app asks Genie for what it
    // needs through the bridge, where there is a grant to check. Chromium's own
    // permission surface has nothing behind it, so nothing gets through.
    view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
    );
    view.webContents.session.setPermissionCheckHandler(() => false);
}

/**
 * Close every window an app has open.
 *
 * Called on revoke and on uninstall: a revoked app whose window stayed up would
 * keep showing a live surface whose every action now fails, which reads as broken
 * rather than as revoked.
 */
export function closeAppWindows(appId: string): void {
    const open = openApps.get(appId);
    if (open && !open.window.isDestroyed()) open.window.close();
    openApps.delete(appId);
    for (const wcId of windowIdsForApp(appId)) {
        const other = BrowserWindow.getAllWindows().find((w) => w.webContents.id === wcId);
        if (other && !other.isDestroyed()) other.close();
    }
}

/**
 * Wipe everything an app stored in its browser partition.
 *
 * Cookies, localStorage, IndexedDB, service workers, cache — everything keyed to
 * `persist:gapp-<id>`. Called on a FRESH install (where it is the guarantee that a
 * new app never inherits a previous claimant's data) and on uninstall (where it is
 * tidiness, because the install-side clear is what actually protects).
 */
export async function clearAppStorage(appId: string): Promise<void> {
    const partition = session.fromPartition(appPartitionFor(appId));
    await partition.clearStorageData();
    await partition.clearCache();
}
