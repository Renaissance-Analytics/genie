/**
 * PURE. What a GApp window's tab strip holds (Tynn #250, App Tray pivot).
 *
 * The window is Genie-drawn. Its FIRST tab is a clone of TheFloor's panel
 * management — terminals and files, exactly as a workspace has them, because a
 * GApp is a special workspace — and the app's own surfaces sit to the right.
 *
 * The order is not decoration. The Agent tab is the one surface Genie owns
 * outright and the app cannot draw, so it is where anything the user must be able
 * to trust belongs. Putting it first, always, is what keeps "am I looking at Genie
 * or at the app?" answerable at a glance.
 */

import type { AppManifest } from './manifest';

export interface AppWindowTab {
    /** `agent` is Genie's own panel management; `app` is the app's web content. */
    kind: 'agent' | 'app';
    title: string;
    /**
     * Where the tab's content lives. ABSENT for the agent tab — that is Genie's
     * own renderer, not web content, and a url here would be a surface an app
     * could one day be pointed at.
     */
    url?: string;
    /** Agent tab only: how much panel management to lay out. */
    panels?: { agents: number; kinds?: string[] };
}

/**
 * The strip, left to right.
 *
 * Every app tab is resolved against the app's OWN origin, derived from the
 * MANIFEST and from nothing else. The manifest already refuses an absolute or
 * protocol-relative path; this is the second half of that promise. Taking a base
 * url from the caller would put a second way to decide where a tab points, and
 * the whole value here is that there is only one.
 */
export function appWindowTabs(manifest: AppManifest): AppWindowTab[] {
    const origin = `https://${manifest.slug}.gen`;
    const resolve = (path: string): string => new URL(path, `${origin}/`).toString();

    const agent: AppWindowTab = {
        kind: 'agent',
        title: 'Agent',
        panels: {
            agents: manifest.panels.agents,
            ...(manifest.panels.kinds ? { kinds: manifest.panels.kinds } : {}),
        },
    };

    const declared = manifest.tabs ?? [];
    const appTabs: AppWindowTab[] = declared.length
        ? declared.map((tab) => ({ kind: 'app', title: tab.title, url: resolve(tab.path) }))
        : // Every GApp serves something. An app that did not enumerate its tabs
          // still gets its front page, or the window would be Genie and nothing
          // else — which is not an app.
          [{ kind: 'app', title: manifest.name, url: resolve('/') }];

    return [agent, ...appTabs];
}
