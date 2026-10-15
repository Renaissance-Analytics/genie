import { isGenHost } from './gen-name.js';

/**
 * THE `.gen` FRONT DOOR (§6.6) — the pure half.
 *
 * Every hosted site is `<name>.gen → 127.0.0.1:<port>`, `<name>` one or more labels (gen-name.ts). The front door is one loopback listener
 * that reads the request's Host and proxies to the site's port. This file decides; the main-side
 * router only moves bytes. Two refusals matter:
 *
 * - **Only `.gen` hosts are served.** A front door that proxied `localhost` or an arbitrary Host
 *   would be an open proxy to whatever listens on the targets.
 * - **Only loopback targets are proxied.** A route whose target is not 127.0.0.1 is treated as
 *   no site at all, at resolution — the one place every request passes.
 *
 * The external-browser path (Chrome/Edge rather than the in-app browser) needs the OS to resolve
 * `<name>.gen` to loopback: a Genie-owned block in the hosts file, between markers, replaced whole
 * and removed clean.
 */

export interface GenRoute {
    readonly host: string;
    /** `127.0.0.1:<port>` — anything else is refused at resolution. */
    readonly target: string;
}

export type RouteResolution =
    | { kind: 'site'; host: string; target: string }
    | { kind: 'no-site'; host: string }
    | { kind: 'not-gen'; host: string | null };

/** Lower-cased, port stripped, trailing dot stripped; `null` when absent or empty. */
export function normalizeHost(header: string | undefined): string | null {
    if (!header) return null;
    let h = header.trim().toLowerCase();
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        h = end >= 0 ? h.slice(0, end + 1) : h;
    } else {
        const colon = h.indexOf(':');
        if (colon >= 0) h = h.slice(0, colon);
    }
    h = h.replace(/\.$/, '');
    return h.length > 0 ? h : null;
}

const LOOPBACK_TARGET = /^127\.0\.0\.1:\d{1,5}$/;

export function resolveRoute(hostHeader: string | undefined, routes: readonly GenRoute[]): RouteResolution {
    const host = normalizeHost(hostHeader);
    if (host === null || !isGenHost(host)) return { kind: 'not-gen', host };
    const route = routes.find((r) => r.host === host);
    if (!route || !LOOPBACK_TARGET.test(route.target)) return { kind: 'no-site', host };
    return { kind: 'site', host, target: route.target };
}

export const HOSTS_BEGIN = '# >>> genie .gen sites — managed, do not edit between the markers';
export const HOSTS_END = '# <<< genie .gen sites';

/** One `127.0.0.1 <host>` line per site, between Genie's markers. */
export function hostsFileBlock(routes: readonly GenRoute[]): string {
    return [HOSTS_BEGIN, ...routes.map((r) => `127.0.0.1 ${r.host}`), HOSTS_END].join('\n');
}

/**
 * The hosts file with Genie's block replaced (or appended). Everything outside the markers is
 * byte-identical to what was there; a file that already matches is returned as is.
 */
export function mergeHostsFile(current: string, routes: readonly GenRoute[]): string {
    const block = hostsFileBlock(routes);
    const begin = current.indexOf(HOSTS_BEGIN);
    const end = current.indexOf(HOSTS_END);
    if (begin >= 0 && end > begin) {
        return current.slice(0, begin) + block + current.slice(end + HOSTS_END.length);
    }
    const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    return `${current}${sep}${block}\n`;
}
