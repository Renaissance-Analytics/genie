/**
 * Where a link clicked INSIDE the ForceTheQuestion modal should go.
 *
 * The modal renders the question as markdown, so a question can carry links. The
 * window is a frameless, always-on-top BrowserWindow — NOT a browser — so a bare
 * `<a href>` click that navigates it turns the modal into a browser tab showing
 * the link, stranding the question (the bug this fixes). The window must never
 * navigate away from the ask page; a link is routed instead:
 *
 *   - a `.gen` link → the Genie Browser (its own tabbed viewer for dev sites),
 *     unless the user turned that off, in which case the machine browser;
 *   - any other web link → the machine's default browser;
 *   - anything that is not http(s) (a `javascript:`/`file:` link) → dropped, the
 *     same defence-in-depth `shell:open-external` applies.
 *
 * The decision is pure ({@link routeAskLink}); the window wiring
 * ({@link wireAskLinkRouting}) takes injected effects so it is testable without
 * an Electron window.
 */

export type AskLinkRoute =
    | { action: 'allow' }
    | { action: 'drop' }
    | { action: 'genie-browser'; url: string }
    | { action: 'external'; url: string };

export interface RouteAskLinkContext {
    /** The window's current URL — a navigation that stays on this origin (a dev
     *  HMR full reload) is the app itself, not an outbound link. */
    currentUrl?: string;
    /** Whether the Genie Browser is on (Settings → genie_browser_enabled). Off
     *  means even a `.gen` link opens in the machine browser. */
    genieBrowserEnabled: boolean;
}

/** Decide where one URL goes. Pure. Never throws — an unparseable URL is dropped. */
export function routeAskLink(rawUrl: string, ctx: RouteAskLinkContext): AskLinkRoute {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { action: 'drop' };
    }

    // The app's own page — let the window be (the initial load never reaches
    // here, but a dev HMR reload navigates to the same origin and must not be
    // hijacked as if it were an outbound link).
    if (isSameOrigin(url, ctx.currentUrl)) return { action: 'allow' };

    // Only ever hand http(s) to a browser. A javascript:/file:/data: link is
    // neither navigated nor shelled out — it is dropped.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { action: 'drop' };

    if (isGenHost(url.hostname)) {
        return ctx.genieBrowserEnabled
            ? { action: 'genie-browser', url: rawUrl }
            : { action: 'external', url: rawUrl };
    }
    return { action: 'external', url: rawUrl };
}

/** A `<name>.gen` host — Genie's dev-site domain. Case-insensitive; a host that
 *  merely contains "gen" (`gen.example.com`) is NOT one. */
function isGenHost(hostname: string): boolean {
    return hostname.toLowerCase().endsWith('.gen');
}

function isSameOrigin(url: URL, currentUrl?: string): boolean {
    if (!currentUrl) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    try {
        return new URL(currentUrl).origin === url.origin;
    } catch {
        return false;
    }
}

// --- window wiring ---------------------------------------------------------

/** The slice of Electron's `WebContents` the wiring touches — structurally typed
 *  so the real thing satisfies it and a test can fake it. */
export interface NavigatingWebContents {
    getURL(): string;
    on(
        event: 'will-navigate',
        listener: (event: { preventDefault(): void }, url: string) => void,
    ): unknown;
    setWindowOpenHandler(
        handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' },
    ): void;
}

export interface AskLinkDeps {
    /** Whether the Genie Browser is enabled right now (read live — the user can
     *  toggle it while the modal is up). */
    genieBrowserEnabled: () => boolean;
    /** Open a URL in the machine's default browser. */
    openExternal: (url: string) => void;
    /** Open a `.gen` URL in the Genie Browser. */
    openGenieBrowser: (url: string) => void;
}

/**
 * Make the modal route links instead of navigating to them.
 *
 * Two escape hatches a link can take are both closed: `will-navigate` (a plain
 * anchor click) is prevented and routed; `setWindowOpenHandler`
 * (`target="_blank"` / `window.open`) is denied and routed. Same-origin
 * navigation is left alone so a dev reload still works.
 */
export function wireAskLinkRouting(wc: NavigatingWebContents, deps: AskLinkDeps): void {
    const dispatch = (route: AskLinkRoute): void => {
        if (route.action === 'genie-browser') deps.openGenieBrowser(route.url);
        else if (route.action === 'external') deps.openExternal(route.url);
        // 'allow' / 'drop' → nothing to open.
    };

    wc.on('will-navigate', (event, url) => {
        const route = routeAskLink(url, {
            currentUrl: wc.getURL(),
            genieBrowserEnabled: deps.genieBrowserEnabled(),
        });
        if (route.action === 'allow') return;
        // Anything else must NOT navigate the modal.
        event.preventDefault();
        dispatch(route);
    });

    wc.setWindowOpenHandler(({ url }) => {
        dispatch(
            routeAskLink(url, {
                currentUrl: wc.getURL(),
                genieBrowserEnabled: deps.genieBrowserEnabled(),
            }),
        );
        // A new window is never spawned from the modal — the routed target opens
        // in the Genie Browser or the machine browser instead.
        return { action: 'deny' };
    });
}
