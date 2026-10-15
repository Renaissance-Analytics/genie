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
 * and removed clean. It carries the CONFIGURED names, never the running ones (genie#624): the
 * hosts file is the one administrator-owned artifact here, so it moves only when the person
 * changes which sites exist — never on a start or a stop.
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

/**
 * GENIE 1'S BLOCK (its `main/dev-server/hosts-file.ts`). An upgrade leaves it behind, carrying names Genie 1 served and
 * nothing serves now. It is taken out by the same write that sets Genie 2's block — never a prompt of its own beyond
 * that one write — and then it is gone, so it is removed once.
 */
export const V1_HOSTS_BEGIN = '# BEGIN GENIE SITES';
export const V1_HOSTS_END = '# END GENIE SITES';

/** A `.gen` name safe to write verbatim into a hosts file: DNS labels only, so a name can never inject a line of its own. */
const HOSTS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.gen$/;

/** Sorted and de-duplicated, so one configured set always renders the same bytes — a reorder never writes. */
export function hostsNames(names: readonly string[]): string[] {
    for (const n of names) if (!HOSTS_NAME.test(n)) throw new Error(`${JSON.stringify(n)} is not a .gen name Genie writes into the hosts file`);
    return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function blockLines(names: readonly string[]): string[] {
    return [HOSTS_BEGIN, ...hostsNames(names).flatMap((n) => [`127.0.0.1 ${n}`, `::1 ${n}`]), HOSTS_END];
}

/**
 * A `127.0.0.1` AND a `::1` line per name, between Genie's markers — both loopbacks, as Genie 1 wrote them, so a
 * resolver that asks for the IPv6 address first still lands on this machine.
 */
export function hostsFileBlock(names: readonly string[]): string {
    return blockLines(names).join('\n');
}

/** Drop the lines from `begin` to `end`; a BEGIN with no END runs to the end of the file, so an interrupted write heals. */
function withoutBlock(lines: readonly string[], begin: string, end: string): { lines: string[]; at: number } {
    const b = lines.findIndex((l) => l.trim() === begin);
    if (b < 0) return { lines: [...lines], at: -1 };
    const rel = lines.slice(b + 1).findIndex((l) => l.trim() === end);
    const e = rel < 0 ? lines.length - 1 : b + 1 + rel;
    return { lines: [...lines.slice(0, b), ...lines.slice(e + 1)], at: b };
}

/**
 * The hosts file with Genie's block set to exactly `names`: replaced where it was, appended when there was none, and
 * gone — markers and all — when there are no names. Genie 1's block is removed in the same pass. Everything else is
 * byte-identical, the file's own line ending (CRLF on Windows) included; a file that already matches comes back
 * unchanged, which is what keeps an unchanged set from writing — and so from prompting.
 */
export function mergeHostsFile(current: string, names: readonly string[]): string {
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const trailing = current.length === 0 || current.endsWith(eol);
    const body = current.endsWith(eol) ? current.slice(0, -eol.length) : current;
    const original = body === '' ? [] : body.split(eol);
    const noV1 = withoutBlock(original, V1_HOSTS_BEGIN, V1_HOSTS_END).lines;
    const ours = withoutBlock(noV1, HOSTS_BEGIN, HOSTS_END);
    const block = names.length > 0 ? blockLines(names) : [];
    const lines = ours.at >= 0 ? [...ours.lines.slice(0, ours.at), ...block, ...ours.lines.slice(ours.at)] : [...ours.lines, ...block];
    if (lines.length === 0) return '';
    return lines.join(eol) + (trailing ? eol : '');
}
