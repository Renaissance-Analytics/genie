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
    /** The vhost this site answers on, e.g. `moic-suite.acme.gen`. This is BOTH
     *  the TLS SNI Caddy routes by and the default `Host` sent upstream. */
    host: string;
    /** The app's PLAIN-HTTP port on loopback inside the sandbox. */
    port: number;
    /**
     * The `Host` header to send the app, when it must differ from {@link host}.
     *
     * The carrier always dials with SNI = Host = the `.gen` name (so Caddy can
     * route by SNI), but some frameworks reject a Host they were not told about —
     * Django's `ALLOWED_HOSTS`, Vite's `allowedHosts`. Setting this makes Caddy
     * REWRITE the upstream Host (`header_up Host`) to a name the app accepts,
     * without the browser-facing origin changing. Omit to pass `.gen` through.
     */
    upstreamHost?: string;
}

/** A hostname Caddy (and a `.gen` vhost) may safely carry — labels + dots only. */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * A vhost as a Caddy header-replacement REGEX — every metacharacter escaped.
 *
 * `header_down <field> <find> <replace>` treats `find` as a regular expression, so
 * an unescaped `api.acme.gen` also matches `apiXacmeXgen` — a DIFFERENT origin,
 * whose URLs we would then rewrite.
 *
 * It escapes the WHOLE metacharacter set, not just the `.` that callers can
 * actually produce today. Every caller currently passes a host already through
 * {@link HOST_RE}, where `.` is the only metacharacter possible — but this is
 * exported and used from host-caddyfile.ts as well, so the guarantee would live at
 * the call sites rather than here, and an escaper is only worth having if it holds
 * on its own. Escaping one character and passing the rest through is the
 * `js/incomplete-sanitization` shape: correct until the first caller that forgets
 * to validate, and then silently an injection. Backslash is in the class and the
 * single pass handles it, so there is no escape-the-escape ordering bug.
 *
 * Shared rather than copied for the same reason `quoteWinToken` is: two copies of
 * an escaping rule drift, and the drift shows up as a hole in whichever copy
 * stopped being maintained.
 */
export function caddyHostPattern(host: string): string {
    return host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertSite(s: CaddySite): void {
    if (typeof s.host !== 'string' || !HOST_RE.test(s.host)) {
        throw new Error(`caddyfile: refusing invalid host ${JSON.stringify(s.host)}`);
    }
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
        throw new Error(`caddyfile: refusing invalid port ${JSON.stringify(s.port)} for ${s.host}`);
    }
    // An upstream Host also lands in the config verbatim, so it gets the same
    // grammar check as the vhost — never an injectable value.
    if (s.upstreamHost !== undefined && (typeof s.upstreamHost !== 'string' || !HOST_RE.test(s.upstreamHost))) {
        throw new Error(
            `caddyfile: refusing invalid upstream host ${JSON.stringify(s.upstreamHost)} for ${s.host}`,
        );
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
            // FORCE https on the app's own IN-BODY self-links. An app built off the
            // plain-http proxy hop (no TrustProxies) renders `http://<name>.gen`
            // Ziggy/route()/asset URLs into its HTML/JSON; a secure client (the
            // Genie Browser) then blocks those as mixed content — the reported
            // `.gen` dead-navigation. The `replace` directive (from the
            // caddyserver/replace-response module baked into the sandbox Caddy;
            // auto-ordered AFTER `encode`, so it runs before the proxy and sees the
            // full response) rewrites the app's own `http://<host>` back to
            // `https://<host>` in the RESPONSE BODY, so NO app needs proxy-trust
            // config. `stream` rewrites incrementally (drops Content-Length) so
            // streamed/SSE responses keep flowing; `header_up -Accept-Encoding`
            // below makes the upstream answer in plaintext so the body is
            // rewritable. Scoped to THIS vhost's own validated host, so the quoted
            // literal is never injectable. (Redirects — `Location` — handled below.)
            '\treplace {',
            '\t\tstream',
            `\t\t"http://${s.host}" "https://${s.host}"`,
            '\t}',
            `\treverse_proxy 127.0.0.1:${s.port} {`,
            // Only when the app checks Host (Django ALLOWED_HOSTS, Vite): rewrite
            // the upstream Host to one it accepts, browser origin unchanged.
            ...(s.upstreamHost ? [`\t\theader_up Host ${s.upstreamHost}`] : []),
            // Strip the upstream's compression so `replace` sees a plaintext body
            // to rewrite (a gzipped response would slip through unchanged). Cheap on
            // a loopback dev hop.
            '\t\theader_up -Accept-Encoding',
            // FORCE https on the app's own redirects. Caddy already sends
            // `X-Forwarded-Proto: https`, but a Laravel app only honours it with
            // TrustProxies; without it, an in-request `redirect()`/`url()` builds
            // off the plain-http proxy hop and emits `Location: http://<name>.gen/…`.
            // The browser then follows it to a scheme Caddy does not serve. Rewrite
            // the redirect scheme back to https at the front door. `^http:` (not
            // `http://`) matches only the leading scheme — leaving `https:` and
            // relative Locations untouched.
            '\t\theader_down Location "^http:" "https:"',
            // FORCE https on the app's own PRELOADS. Laravel's Vite integration
            // advertises every asset in ONE `Link` header, built with `url()`, so an
            // app that does not know it is behind TLS emits `http://<name>.gen/…`
            // there — and a header is invisible to the body `replace` above. On
            // biz.gen that blocked 36 font/style/script preloads as mixed content
            // while the (rewritten) markup looked perfect. Unlike `Location`, which
            // holds ONE url and so matches at `^http:`, this header holds MANY: match
            // the host anywhere and replace ALL of them, scoped to THIS site so a
            // third-party CDN preload stays exactly as the app wrote it.
            `\t\theader_down Link "http://${caddyHostPattern(s.host)}" "https://${s.host}"`,
            '\t}',
            '}',
            '',
        ].join('\n'),
    );

    return [...header, ...blocks].join('\n');
}
