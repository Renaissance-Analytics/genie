import { resolveRoute, type GenRoute } from './gen-router.js';

export type { GenRoute };

/**
 * THE GENIE BROWSER — the pure half: what the in-app browser may open, and where a `.gen`
 * navigation goes.
 *
 * The engine is Electron's own `WebContentsView`; the policy is Genie's, and it has two rules:
 *
 * 1. A `.gen` host is served by the front door, so the pane loads the site's LOOPBACK target and
 *    keeps the `.gen` name in the address bar and the `Host` header — the site sees the name it
 *    was created under. A `.gen` name nobody serves is `no-site`, so the pane can offer to create
 *    it. The front door's own rule (only loopback targets) is reused, not re-decided.
 * 2. The pane opens WEB content only. `file:`, `javascript:`, `chrome:`, `data:`, `about:` and the
 *    app's own `genie:` scheme are refused BY NAME — a browser pane that could load `file:///` is a
 *    file reader with a renderer attached, and `genie:` inside a web pane would nest the app in
 *    itself.
 */

export type Navigation =
    | { kind: 'site'; host: string; url: string; hostHeader: string }
    | { kind: 'no-site'; host: string }
    | { kind: 'web'; url: string }
    | { kind: 'refused'; scheme: string; reason: string };

const WEB_SCHEMES = new Set(['http:', 'https:']);

/** Bare text (`example.com`, `tynn.gen`, `localhost:5173`) is given a scheme; never a file path. */
function toUrl(input: string): URL | null {
    const text = input.trim();
    if (text.length === 0) return null;
    try {
        if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return new URL(text);
        return new URL(`https://${text}`);
    } catch {
        return null;
    }
}

export function classifyNavigation(input: string, routes: readonly GenRoute[]): Navigation {
    const url = toUrl(input);
    if (url === null) return { kind: 'refused', scheme: '', reason: `${JSON.stringify(input)} is not a URL` };
    if (!WEB_SCHEMES.has(url.protocol)) {
        const scheme = url.protocol.slice(0, -1);
        return { kind: 'refused', scheme, reason: `the browser opens web pages only; ${scheme}: is not opened here` };
    }
    const route = resolveRoute(url.host, routes);
    if (route.kind === 'site') {
        const target = new URL(url.toString());
        target.protocol = 'http:';
        target.host = route.target;
        return { kind: 'site', host: route.host, url: target.toString(), hostHeader: route.host };
    }
    if (route.kind === 'no-site') return { kind: 'no-site', host: route.host };
    return { kind: 'web', url: url.toString() };
}

/** `genie://browser?url=<encoded>` — the pane's state lives in the URL, so back and deep links work. */
export const browserRoute = {
    format(state: { url?: string }): string {
        return state.url === undefined ? 'genie://browser' : `genie://browser?url=${encodeURIComponent(state.url)}`;
    },
    parse(route: string): { url?: string } | null {
        const m = /^genie:\/\/browser(?:\?(.*))?$/.exec(route);
        if (!m) return null;
        if (m[1] === undefined) return {};
        const url = new URLSearchParams(m[1]).get('url');
        return url === null ? {} : { url };
    },
};
