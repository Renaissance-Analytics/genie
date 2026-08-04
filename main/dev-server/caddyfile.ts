/**
 * The per-workspace Caddy proxy config.
 *
 * The dev-server model runs every site as a plain-http process inside the ONE
 * workspace sandbox container, on whatever port its (user-controlled) command
 * binds. A Caddy instance runs in that SAME container and is the single front
 * door: it publishes ONE stable https port, and for each enabled site it
 * TLS-terminates `<name>.gen` and reverse-proxies to that app's loopback port.
 *
 * This is what delivers two properties the model promises:
 *   - **ports are masked** — the browser only ever talks to Caddy on the shared
 *     https port; the app's real port is a private loopback detail; and
 *   - **https is forced** — every `.gen` is served over TLS at Caddy, regardless
 *     of the app speaking plain http behind it.
 *
 * Caddy's leaf cert is never trust-checked (the in-app carrier dials it with
 * validation off, and the browser-facing cert is the Genie CA at the carrier), so
 * Caddy's `tls internal` issuer is all that's needed here.
 *
 * PURE string builder — no Caddy, no fs — so the generated config is
 * deterministically testable and a reload with unchanged sites is a true no-op.
 */

/** The single https port Caddy listens on inside the sandbox (published once). */
export const CADDY_HTTPS_PORT = 8443;

export interface CaddySite {
    /** The vhost this site answers on, e.g. `moic-suite.acme.gen`. */
    host: string;
    /** The app's PLAIN-HTTP port on loopback inside the sandbox. */
    port: number;
}

/** A hostname Caddy (and a `.gen` vhost) may safely carry — labels + dots only. */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function assertSite(s: CaddySite): void {
    if (typeof s.host !== 'string' || !HOST_RE.test(s.host)) {
        throw new Error(`caddyfile: refusing invalid host ${JSON.stringify(s.host)}`);
    }
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
        throw new Error(`caddyfile: refusing invalid port ${JSON.stringify(s.port)} for ${s.host}`);
    }
}

/**
 * Build the workspace Caddyfile for `sites`. Sorted by host so the SAME set of
 * sites always yields byte-identical output (a reload can then be skipped when
 * nothing changed). Throws on a bad host/port rather than emit a config that is
 * injectable or silently broken.
 */
export function buildCaddyfile(sites: CaddySite[]): string {
    for (const s of sites) assertSite(s);
    const sorted = [...sites].sort((a, b) => a.host.localeCompare(b.host));

    const header = [
        '{',
        // No plaintext http anywhere: only the shared https listener is bound, and
        // the admin API stays on its default loopback socket for `caddy reload`.
        '\tauto_https disable_redirects',
        '}',
        '',
    ];

    const blocks = sorted.map((s) =>
        [
            `${s.host}:${CADDY_HTTPS_PORT} {`,
            '\ttls internal',
            `\treverse_proxy 127.0.0.1:${s.port}`,
            '}',
            '',
        ].join('\n'),
    );

    return [...header, ...blocks].join('\n');
}
