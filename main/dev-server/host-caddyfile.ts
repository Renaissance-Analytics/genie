/**
 * The HOST reverse-proxy config for host-native `.gen` sites.
 *
 * In the container model a Caddy runs INSIDE the workspace sandbox on :8443 with
 * `tls internal`, reached only by the in-app carrier (see caddyfile.ts). Host-
 * native (Wish #102, story #238) instead runs ONE Caddy on the HOST that owns
 * :443, so the machine's REAL browser can reach `https://<name>.gen` after a
 * hosts-file entry (hosts-file.ts) resolves the name to loopback. Because a real
 * browser validates the certificate, this Caddy serves a leaf issued by the Genie
 * local CA (installed in the OS trust store), NOT Caddy's internal issuer.
 *
 * It keeps the two properties the sandbox Caddy delivered — ports masked, https
 * forced (the beta.236 body `replace` + `Location` rewrite) — and adds a plain
 * `:80 → :443` redirect so a bare `name.gen` typed into the browser lands on TLS.
 *
 * PURE string builder — no Caddy, no fs — so the config is deterministically
 * testable and a reload with an unchanged site set is a true no-op.
 */

import { caddyHostPattern } from './caddyfile';

/** The single https port the HOST Caddy listens on. */
export const HOST_CADDY_HTTPS_PORT = 443;

/** The plain http port the redirect listener binds. */
const HOST_CADDY_HTTP_PORT = 80;

export interface HostCaddySite {
    /** The vhost this site answers on, e.g. `moic.gen`. Both the TLS SNI and the
     *  default upstream `Host`. */
    host: string;
    /** The upstream port on the HOST's loopback (127.0.0.1:port) — a host-native
     *  dev server's plain-http port, or (for a container site) its sandbox Caddy's
     *  published https port. */
    port: number;
    /** The `Host` header to send the app when it must differ from {@link host}
     *  (Django `ALLOWED_HOSTS`, Vite `allowedHosts`). Omit to pass `.gen` through. */
    upstreamHost?: string;
    /**
     * How to reach the upstream. `http` (default) = a host-native dev server on
     * plain loopback. `https-insecure` = a CONTAINER site's sandbox Caddy, which
     * serves a self-signed leaf and routes by Host — so the hop is https with
     * verification skipped and `Host`/SNI set to the gen name (exactly how the
     * in-app carrier reaches it). The browser-facing leaf is unaffected — only this
     * upstream hop is insecure-skipped.
     */
    upstreamScheme?: 'http' | 'https-insecure';
}

/** The single Genie-CA leaf (multi-SAN over every live `.gen`) every vhost serves. */
export interface HostCaddyTls {
    certPath: string;
    keyPath: string;
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function assertSite(s: HostCaddySite): void {
    if (typeof s.host !== 'string' || !HOST_RE.test(s.host)) {
        throw new Error(`host-caddyfile: refusing invalid host ${JSON.stringify(s.host)}`);
    }
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
        throw new Error(`host-caddyfile: refusing invalid port ${JSON.stringify(s.port)} for ${s.host}`);
    }
    if (s.upstreamHost !== undefined && (typeof s.upstreamHost !== 'string' || !HOST_RE.test(s.upstreamHost))) {
        throw new Error(
            `host-caddyfile: refusing invalid upstream host ${JSON.stringify(s.upstreamHost)} for ${s.host}`,
        );
    }
}

/** A cert/key path lands in the config quoted; normalise Windows `\` to `/`
 *  (Caddy accepts forward slashes on Windows and it dodges quote-escaping), then
 *  refuse anything that could break out of the quotes or inject a directive. */
function quotePath(p: string, which: string): string {
    if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`host-caddyfile: missing ${which} path`);
    }
    const norm = p.replace(/\\/g, '/');
    if (/["\n\r{}]/.test(norm)) {
        throw new Error(`host-caddyfile: refusing injectable ${which} path ${JSON.stringify(p)}`);
    }
    return `"${norm}"`;
}

/**
 * Build the HOST Caddyfile for `sites`, all served with the one Genie-CA leaf in
 * `tls`. Sorted by host so the same set yields byte-identical output (a reload can
 * then be skipped when nothing changed). Throws on a bad host/port/upstream or an
 * injectable cert path rather than emit a broken or injectable config.
 */
export function buildHostCaddyfile(sites: HostCaddySite[], tls: HostCaddyTls): string {
    for (const s of sites) assertSite(s);
    const sorted = [...sites].sort((a, b) => a.host.localeCompare(b.host));

    const header = [
        '{',
        // We manage TLS ourselves (the Genie CA leaf), so Caddy must not try to
        // auto-provision or auto-redirect; our own :80 blocks do the redirect.
        '\tauto_https disable_redirects',
        '}',
        '',
    ];

    // No sites ⇒ no vhost references a cert, so don't demand one (the reconcile
    // engine writes this empty config before any leaf has been issued).
    if (sorted.length === 0) return header.join('\n');

    const cert = quotePath(tls.certPath, 'cert');
    const key = quotePath(tls.keyPath, 'key');

    const blocks = sorted.flatMap((s) => [
        // Plain http → https, so a bare `name.gen` typed in the browser lands on TLS.
        `http://${s.host}:${HOST_CADDY_HTTP_PORT} {`,
        `\tredir https://${s.host}{uri} permanent`,
        '}',
        '',
        `${s.host}:${HOST_CADDY_HTTPS_PORT} {`,
        // The Genie CA leaf — trusted by the real browser via the OS trust store.
        `\ttls ${cert} ${key}`,
        // FORCE https on the app's own in-body self-links (beta.236). The `replace`
        // directive (caddyserver/replace-response, auto-ordered after `encode`, so
        // it sees the full response before the proxy) rewrites `http://<host>` back
        // to `https://<host>` in the RESPONSE BODY, so no app needs proxy-trust
        // config. `stream` rewrites incrementally so SSE keeps flowing.
        //
        // ...but NEVER on an upgraded connection. A WebSocket through here opened
        // and then went permanently silent — no frame ever arrived, so Echo sat at
        // "unavailable", which reads like a broken upgrade and is not one. Measured
        // against a real browser, `replace` and HTTP/2 are BOTH needed to break it:
        // over h1 the rewriter is harmless, and with h2 available it swallows every
        // frame. h2 is the norm here rather than the exception — every `.gen` name
        // shares ONE leaf on ONE address, so Chromium coalesces a socket to
        // `websockets.<ws>.gen` onto the connection it already holds for the page and
        // sends it as an Extended CONNECT stream. A site's own same-origin `wss://`
        // (Vite HMR, Echo on the app's host) rides the same coalesced connection.
        //
        // Gating costs nothing: a WebSocket has no HTML body of self-links to fix.
        // Both forms must be excluded — an h1 upgrade carries `Connection: Upgrade`,
        // while the h2 one carries no such header at all and is a CONNECT, so
        // matching only the header would let the broken case straight through.
        '\t@rewritable {',
        '\t\tnot header Connection *Upgrade*',
        '\t\tnot method CONNECT',
        '\t}',
        '\treplace @rewritable {',
        '\t\tstream',
        `\t\t"http://${s.host}" "https://${s.host}"`,
        '\t}',
        s.upstreamScheme === 'https-insecure'
            ? `\treverse_proxy https://127.0.0.1:${s.port} {`
            : `\treverse_proxy 127.0.0.1:${s.port} {`,
        // Container upstream: route the sandbox Caddy by Host = the gen name (it
        // routes by Host and applies the app's own upstreamHost internally). A
        // host-native upstream only rewrites Host when the app pins one.
        ...(s.upstreamScheme === 'https-insecure'
            ? [`\t\theader_up Host ${s.host}`]
            : s.upstreamHost
              ? [`\t\theader_up Host ${s.upstreamHost}`]
              : []),
        // Strip upstream compression so `replace` sees a plaintext body to rewrite.
        '\t\theader_up -Accept-Encoding',
        // FORCE https on the app's own redirects (beta.236): rewrite a leading
        // `http:` Location back to `https:` at the front door.
        '\t\theader_down Location "^http:" "https:"',
        // FORCE https on the app's own PRELOADS — the gap beta.236 left, measured on
        // biz.gen. Laravel's Vite integration advertises every asset in ONE `Link`
        // header built with `url()`, so an app that does not know it is behind TLS
        // emits `http://<name>.gen/…` there; a header never passes through the body
        // `replace`, so the browser blocked 36 font/style/script preloads as mixed
        // content while the markup looked perfect. It reads as PHP-only because a
        // Node dev server emits no preload `Link` header at all. `Location` holds ONE
        // url and matches at `^http:`; this holds MANY, so match the (escaped) host
        // anywhere and replace ALL of them — third-party preloads untouched.
        `\t\theader_down Link "http://${caddyHostPattern(s.host)}" "https://${s.host}"`,
        // A container upstream (its sandbox Caddy) serves a self-signed leaf and
        // expects SNI = the gen name; dial https, skip verification, set the SNI.
        ...(s.upstreamScheme === 'https-insecure'
            ? ['\t\ttransport http {', '\t\t\ttls_insecure_skip_verify', `\t\t\ttls_server_name ${s.host}`, '\t\t}']
            : []),
        '\t}',
        '}',
        '',
    ]);

    return [...header, ...blocks].join('\n');
}
