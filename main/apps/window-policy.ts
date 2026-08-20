/**
 * PURE. How a GApp's window is locked down (Tynn #250).
 *
 * A GApp's front end is developer-authored web content — that is the point of the
 * SDK — served from its own `<slug>.gen` origin and shown in a dedicated window.
 * It is therefore THIRD-PARTY CODE inside Genie's process tree, and the only thing
 * that makes that acceptable is the window it gets.
 *
 * The decisions live here, apart from the Electron call that consumes them, so
 * they can be asserted exactly. Every flag below is a single boolean between "a
 * sandboxed web page" and "third-party code with Node", and a regression in one of
 * them would be invisible in a screenshot.
 */

import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * The GApp preload — NOT Genie's own.
 *
 * `preload.js` exposes the full desktop API; loading it here would hand a
 * third-party page everything at once. This one exposes a single mediated call
 * that goes through `decideAppCall`.
 */
export const APP_PRELOAD_FILENAME = 'app-preload.js';

export interface AppWindowIdentity {
    id: string;
    slug: string;
}

/**
 * A storage partition per app.
 *
 * Two apps must not share cookies, localStorage, IndexedDB or service workers,
 * and neither may read Genie's own. It is also what makes uninstall mean
 * something: the partition goes with the app.
 */
export function appPartitionFor(appId: string): string {
    // The id is reverse-DNS (`validateAppManifest` enforces it), so it is already
    // partition-safe; the replace is belt and braces for a hand-built identity.
    return `persist:gapp-${appId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

export interface AppWindowOptions {
    /**
     * The app is being BUILT here.
     *
     * Exactly one switch: dev tools. Everything else — the sandbox, context
     * isolation, no Node, web security, the partition — is identical, because a
     * developer's window is not a place to discover that the isolation only ever
     * worked because of a flag.
     */
    devMode?: boolean;
}

export function appWindowOptions(
    app: AppWindowIdentity,
    preloadPath: string,
    options: AppWindowOptions = {},
): BrowserWindowConstructorOptions {
    return {
        width: 1100,
        height: 780,
        minWidth: 480,
        minHeight: 360,
        show: false,
        // The app's own name, never Genie's. The window chrome is Genie-drawn and
        // not themeable — the structural half of anti-impersonation — and the title
        // is where the user reads whose window this is.
        title: options.devMode
            ? `${app.slug} — Genie App (development)`
            : `${app.slug} — Genie App`,
        autoHideMenuBar: true,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            // Full Chromium sandbox. Genie's own windows run unsandboxed because
            // their preload needs Node; this one's does not.
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            partition: appPartitionFor(app.id),
            // Closed for everyone else's app, so a third-party page cannot be
            // talked into opening one; open for an app you are building, which you
            // have to be able to inspect.
            devTools: options.devMode === true,
        },
    };
}

export interface NavigationDecision {
    allow: boolean;
    /** Hand it to the user's real browser instead — visibly, outside this session. */
    openExternally?: boolean;
    reason: string;
}

/**
 * Where a GApp window may navigate.
 *
 * Same-origin only. Anything else in-window would put the app inside another
 * origin's session — including another GApp's partitioned storage. An ordinary
 * web link is still a reasonable thing for an app to contain, so it opens where
 * links belong: the user's browser. A non-web scheme is neither, and is refused
 * outright rather than handed to the OS, which would only move the problem.
 */
export function decideAppNavigation(homeUrl: string, targetUrl: string): NavigationDecision {
    let home: URL;
    let target: URL;
    try {
        home = new URL(homeUrl);
        target = new URL(targetUrl);
    } catch {
        return { allow: false, reason: 'Not a URL Genie can read, so it is not followed.' };
    }

    // `file:` reads the disk; `javascript:` and `data:` execute. None is a page.
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return {
            allow: false,
            reason: `Genie Apps may not navigate to ${target.protocol} URLs.`,
        };
    }

    // Origin comparison, never string containment: `nottrader.gen` and
    // `trader.gen.evil.com` both contain the app's host as a substring.
    if (target.origin === home.origin) {
        return { allow: true, reason: 'Inside the app’s own site.' };
    }

    if (target.protocol !== 'https:') {
        // Genie serves .gen over https and rewrites http to it; accepting http here
        // would reopen the downgrade the hosting layer exists to close.
        return { allow: false, reason: 'Genie Apps may only open https links externally.' };
    }

    return {
        allow: false,
        openExternally: true,
        reason: 'Opened in your browser, outside the app’s window.',
    };
}
