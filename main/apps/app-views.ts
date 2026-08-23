/**
 * The views a GApp's own tabs live in (Tynn #250, App Tray pivot).
 *
 * The window belongs to Genie: Genie draws the frame, the tab strip and the Agent
 * tab. The app's surfaces are embedded views inside it — which creates exactly one
 * mistake capable of undoing the whole model.
 *
 * **The bridge identifies a caller by its webContents.** Register the wrong one and
 * `gapp:call` starts answering for it. The Genie SHELL must therefore never be
 * registered as the app: it runs Genie's own preload with the whole desktop API,
 * and handing it the app's grant would let the app's identity be spoken with
 * Genie's privileges.
 *
 * This module is built so that cannot happen by construction: it registers only
 * webContents it CREATED ITSELF, and it has no way to name one it did not make.
 *
 * The Electron calls are injected so the wiring is assertable — every property
 * here is about which surface got which privileges, and none of it is visible in a
 * screenshot.
 */

import { appViewOptions, type AppViewPreferences, type AppWindowOptions } from './window-policy';
import { gappHomeUrl } from './hostname';
import type { AppWindowTab } from './window-tabs';
import type { AppManifest } from './manifest';

/** One created view, as this module tracks it. */
export interface AttachedAppView<V = unknown> {
    title: string;
    url: string;
    view: V;
}

export interface AppViewDeps<V = unknown> {
    /** Construct the embedded view with these preferences. */
    makeView: (prefs: AppViewPreferences) => V;
    /** Tell the bridge this view IS the app. Only ever called with what we made. */
    register: (view: V, appId: string) => void;
    loadURL: (view: V, url: string) => void;
    /** Same-origin in-window; an external link goes to the real browser. */
    guardNavigation: (view: V, homeUrl: string) => void;
    preloadPath: string;
}

/**
 * Create and register a view for every APP tab.
 *
 * The Agent tab deliberately gets none: it is Genie's own renderer, and giving it
 * a view would mean giving it the app's preload and the app's grant.
 */
export function attachAppTabViews<V>(
    manifest: AppManifest,
    tabs: AppWindowTab[],
    deps: AppViewDeps<V>,
    options: AppWindowOptions = {},
): AttachedAppView<V>[] {
    const identity = { id: manifest.id, slug: manifest.slug };
    const home = gappHomeUrl(manifest.slug);

    return tabs
        .filter((tab): tab is AppWindowTab & { url: string } => tab.kind === 'app' && !!tab.url)
        .map((tab) => {
            const view = deps.makeView(appViewOptions(identity, deps.preloadPath, options));
            // Registered immediately, and only ever this view: the app's identity
            // belongs to the surfaces running the app's code and to nothing else.
            deps.register(view, manifest.id);
            deps.guardNavigation(view, home);
            deps.loadURL(view, tab.url);
            return { title: tab.title, url: tab.url, view };
        });
}

/**
 * Where an app view sits: the whole window below the tab strip.
 *
 * Clamped at zero because a collapsed or mid-animation window would otherwise hand
 * Electron a negative height — which throws, and would take the shell down with it.
 */
export function appViewBounds(
    content: { width: number; height: number },
    stripHeight: number,
): { x: number; y: number; width: number; height: number } {
    return {
        x: 0,
        y: stripHeight,
        width: Math.max(0, content.width),
        height: Math.max(0, content.height - stripHeight),
    };
}
