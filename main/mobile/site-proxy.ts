import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { isLocked, audit } from './audit';
import { sessionFromAuthHeader, validateSession } from './auth';
import type { SiteScheme } from './hosts';

/**
 * HOST-side reverse proxy for serve-local-sites (Phase C, design §2 + §3(a)).
 *
 * A name-based reverse proxy that, for an ALLOWLISTED discovered site, opens a
 * connection to `127.0.0.1:<port>` (terminating the site's local TLS on
 * loopback) and STREAMS the response back over today's tailnet listener
 * (`server.ts`). It re-serves a TLS `*.test` vhost as plain http to the remote,
 * so it also applies the http-fallback header rewrites (§2). The Testing
 * Browser + `*.gen` + session CA that give the remote a valid `https://` secure
 * context are Phase D — NOT here; this is the pipe under them.
 *
 * SECURITY — this module REUSES the existing mobile primitives, never
 * re-implements them (design §2 "safety rails" + §5):
 *   - **Token gate** — every proxied request + WS upgrade needs a live session
 *     token (Bearer for programmatic callers; `?__genie_token=` for a browser
 *     WS that can't set Authorization). Unauthed ⇒ 401.
 *   - **Kill-switch on ALL methods** — while `isLocked()` we return 423 for
 *     EVERY method incl. GET (a local admin panel / mailcatcher / phpMyAdmin is
 *     sensitive even on a read).
 *   - **Both opt-ins at serve time** — the global `local_sites_enabled` master
 *     switch (finally host-enforced HERE — Phase B only stored it) AND the
 *     per-site `enabled` allowlist entry, resolved via the injected deps. Master
 *     off ⇒ 403; unknown/disabled/out-of-scope site ⇒ 404.
 *   - **SSRF / open-proxy guard** — the remote selects a site ONLY by its opaque
 *     `siteId`; the target is resolved STRICTLY from the discovered + enabled +
 *     served set (`deps.resolveSite`). The remote can NEVER supply a raw
 *     `Host`/target, and we dial `127.0.0.1` ONLY — never the discovered IP
 *     literally or any remote-supplied address.
 *   - **Audit** — `site.open` on the first request per site, actor =
 *     `token.slice(0,8)`, mirroring the other `audit()` calls.
 *   - **DNS-rebinding** — the WS upgrade inherits `server.ts`'s `originAllowed`
 *     discipline (passed in), like `/ws/term`.
 *
 * KNOWN Phase-C LIMITATION (fixed by Phase D's `.gen` root-origin): we rewrite
 * RESPONSE HEADERS only (`Location`, HSTS, `Set-Cookie` Secure) — we do NOT
 * rewrite absolute URLs embedded in HTML/CSS/JS bodies. A site that emits a
 * root-absolute asset URL (`/css/app.css`) or an absolute `https://tynn.test/…`
 * in its markup will break under the path-prefixed addressing here; the design
 * explicitly rejects the fragile body-rewriting path in favour of Phase D
 * serving each site at its OWN `https://<repo>.gen` root origin.
 */

// --- constants -------------------------------------------------------------

/** We dial loopback ONLY — never the discovered IP literally, never a
 *  remote-supplied address. This is the hard floor of the SSRF guard. */
const LOOPBACK = '127.0.0.1';

/** The proxy URL prefix a site is addressed under: `/api/site/<siteId>/<path…>`. */
export const SITE_PROXY_PREFIX = '/api/site/';

/**
 * The query param a browser WS uses to convey the Genie session token (a WS
 * upgrade can't set an `Authorization` header). NAMESPACED so it can't collide
 * with an upstream dev server's own `?token=` (Vite HMR, Reverb, …), and we
 * STRIP it from the upstream path so the Genie token never leaks to the site.
 */
export const GENIE_TOKEN_PARAM = '__genie_token';

/**
 * Phase-D "preserve-origin" signal. The REMOTE forward-proxy shim
 * (`main/remote/site-proxy.ts`) sets this request header when it serves a site to
 * the Testing Browser under its REAL `https://<name>.gen` origin. In that mode the
 * browser already has a valid secure context, so the host proxy must NOT apply its
 * Phase-C http-downgrade RESPONSE rewrites (Location→proxy-prefix, HSTS strip,
 * Secure-cookie clear) — the shim does the single `.test`⇄`.gen` origin map
 * instead. Absent (a Phase-C client) ⇒ the http-downgrade rewrites apply as
 * before. STRIPPED from the upstream request so the Genie control header never
 * reaches the local site.
 */
export const PRESERVE_ORIGIN_HEADER = 'x-genie-preserve-origin';

/**
 * Hop-by-hop headers (RFC 7230 §6.1) plus the `Proxy-*` family — stripped on
 * BOTH the upstream request and the downstream response. `Upgrade`/`Connection`
 * are hop-by-hop too but MUST be preserved for a WebSocket upgrade (see the
 * `keepUpgrade` option in {@link buildUpstreamHeaders}).
 */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

// --- types -----------------------------------------------------------------

/**
 * The loopback target an opaque `siteId` resolves to — produced STRICTLY from
 * the discovered + per-site-enabled + served-workspace set by
 * {@link SiteProxyDeps.resolveSite}. Never assembled from remote input.
 */
export interface ResolvedSite {
    /** The vhost name to force into `Host` (and, for https, TLS SNI). */
    hostname: string;
    /** The scheme the site is served under on loopback. */
    scheme: SiteScheme;
    /** The loopback port to dial (always at `127.0.0.1`). */
    port: number;
}

/**
 * The host-injected settings/allowlist accessors the proxy needs — mirrors the
 * `MobileDataDeps` pattern so a test injects them without touching real sqlite,
 * and so this module never imports the DB directly.
 */
export interface SiteProxyDeps {
    /**
     * The global master switch (Settings → `local_sites_enabled`). Enforced at
     * serve time HERE (Phase B only stored it). Off ⇒ nothing is served.
     */
    localSitesEnabled: () => boolean;
    /**
     * Resolve an opaque `siteId` to its loopback target, STRICTLY from the
     * discovered + per-site-`enabled` + served-workspace set. Returns null for
     * an unknown / disabled / infra-default-off / out-of-scope id — which is
     * also what makes an SSRF attempt (a raw host/target dressed as a `siteId`)
     * fail closed: it simply doesn't resolve. Never dials, never trusts input.
     */
    resolveSite: (siteId: string) => Promise<ResolvedSite | null> | ResolvedSite | null;
}

/** Per-request proxy context from `server.ts` (the remote-facing origin, for
 *  `Location` rewrites). */
export interface SiteProxyInfo {
    /** The origin the proxy is served on to the remote — `scheme://host:port`
     *  (`https://<magic-dns>:<port>` over a Tailscale cert, else
     *  `http://<ip>:<port>`). Drives the `Location`/scheme header rewrites. */
    proxyOrigin: string;
}

// --- pure helpers (unit-testable) ------------------------------------------

/**
 * PURE. Parse a `/api/site/<siteId>/<upstreamPath?query>` URL into its opaque
 * `siteId` and a ROOT-RELATIVE upstream path (defaulting to `/`), preserving the
 * raw query verbatim. Returns null for a non-site-proxy URL. The `siteId` is the
 * ONLY selector — no host/target is ever taken from the remote (SSRF-safe).
 */
export function parseSiteProxyUrl(
    url: string | undefined,
): { siteId: string; upstreamPath: string } | null {
    if (!url) return null;
    const m = /^\/api\/site\/([^/?#]+)(.*)$/.exec(url);
    if (!m) return null;
    const siteId = m[1];
    let rest = m[2] || '';
    if (rest === '') rest = '/';
    else if (rest.startsWith('?')) rest = `/${rest}`; // query with no path → root
    return { siteId, upstreamPath: rest };
}

/**
 * PURE. Drop our namespaced WS token param ({@link GENIE_TOKEN_PARAM}) from an
 * upstream path so the Genie session token never reaches the local site. Leaves
 * the path BYTE-FOR-BYTE untouched when our param is absent (the common case),
 * so an upstream's own query encoding is never disturbed.
 */
export function stripTokenParam(upstreamPath: string): string {
    if (!upstreamPath.includes(GENIE_TOKEN_PARAM)) return upstreamPath;
    const qIdx = upstreamPath.indexOf('?');
    if (qIdx === -1) return upstreamPath;
    const base = upstreamPath.slice(0, qIdx);
    const params = new URLSearchParams(upstreamPath.slice(qIdx + 1));
    params.delete(GENIE_TOKEN_PARAM);
    const q = params.toString();
    return q ? `${base}?${q}` : base;
}

/**
 * PURE. Build the upstream request headers: copy the inbound set, but
 *   - FORCE `Host` to the site's vhost name (THE crux — the local proxy routes
 *     on Host; without this it serves its default/404 vhost),
 *   - drop the inbound `Authorization` (never leak the Genie token to the site),
 *   - strip hop-by-hop + `Proxy-*` headers (and any header the peer listed in
 *     `Connection`).
 * For a WebSocket upgrade, `keepUpgrade` preserves `Upgrade`/`Connection` so the
 * handshake survives.
 */
export function buildUpstreamHeaders(
    inbound: http.IncomingHttpHeaders,
    hostname: string,
    opts: { keepUpgrade?: boolean } = {},
): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    const connTokens = connectionTokens(inbound['connection']);
    for (const [k, v] of Object.entries(inbound)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (lk === 'host') continue; // rewritten below (the crux)
        if (lk === 'authorization') continue; // never leak the Genie token
        if (lk === PRESERVE_ORIGIN_HEADER) continue; // Genie control header — never leaks upstream
        if (lk.startsWith('proxy-')) continue; // Proxy-* family
        if (HOP_BY_HOP.has(lk)) {
            if (opts.keepUpgrade && (lk === 'upgrade' || lk === 'connection')) {
                out[k] = v; // keep the upgrade mechanics for a WS handshake
            }
            continue;
        }
        if (connTokens.has(lk)) continue; // header the peer marked hop-by-hop
        out[k] = v;
    }
    out['host'] = hostname;
    return out;
}

/**
 * PURE. Rewrite one `Location` header for the http re-serve (§2). We only
 * rewrite the SITE's OWN origin (a cross-site absolute redirect is left as-is —
 * an acknowledged Phase-C limitation) and root-relative targets (which would
 * otherwise resolve against the proxy root and lose the `/api/site/<id>` prefix).
 */
export function rewriteLocation(
    location: string,
    site: ResolvedSite,
    siteId: string,
    proxyOrigin: string,
): string {
    const prefix = `${SITE_PROXY_PREFIX}${siteId}`;
    const loc = location.trim();
    if (!loc) return location;
    // Absolute (`scheme://host…`) or scheme-relative (`//host…`).
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(loc)) {
        try {
            const u = new URL(loc, 'http://genie-proxy-base.invalid');
            if (u.hostname.toLowerCase() === site.hostname.toLowerCase()) {
                // Map the site origin → the proxy origin (https→http downgrade is
                // implicit in proxyOrigin's scheme) + the site path prefix.
                return `${proxyOrigin}${prefix}${u.pathname}${u.search}${u.hash}`;
            }
            return loc; // a different host — not ours to rewrite
        } catch {
            return loc;
        }
    }
    // Root-relative (`/path`, but not `//`) — carry the site prefix.
    if (loc.startsWith('/')) return `${prefix}${loc}`;
    // A truly relative Location resolves against the request path (which already
    // carries the prefix) — leave it.
    return location;
}

/**
 * PURE. Rewrite the downstream RESPONSE headers for the http re-serve (§2):
 *   - strip hop-by-hop + `Proxy-*` (let Node re-frame the body),
 *   - strip `Strict-Transport-Security` (the upstream's HSTS policy is about
 *     `tynn.test`, never the ephemeral proxy origin — leaving it would try to
 *     pin the proxy origin to https),
 *   - rewrite `Location` (see {@link rewriteLocation}),
 *   - clear the `Secure` flag on `Set-Cookie` WHEN re-serving over plain http
 *     (a Secure cookie would be dropped by the browser over http). Over a
 *     Tailscale-cert https re-serve the secure context holds, so we keep it.
 */
export function rewriteResponseHeaders(
    upstream: http.IncomingHttpHeaders,
    site: ResolvedSite,
    siteId: string,
    proxyOrigin: string,
): http.OutgoingHttpHeaders {
    const proxySecure = proxyOrigin.startsWith('https:');
    const out: http.OutgoingHttpHeaders = {};
    const connTokens = connectionTokens(upstream['connection']);
    for (const [k, v] of Object.entries(upstream)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue; // Node re-frames content-length/chunking
        if (connTokens.has(lk)) continue;
        if (lk === 'strict-transport-security') continue; // strip HSTS
        if (lk === 'location') {
            out[k] = rewriteLocation(String(v), site, siteId, proxyOrigin);
            continue;
        }
        if (lk === 'set-cookie') {
            const cookies = Array.isArray(v) ? v : [String(v)];
            out[k] = proxySecure ? cookies : cookies.map(clearSecureCookie);
            continue;
        }
        out[k] = v;
    }
    return out;
}

/**
 * PURE. Phase-D "preserve-origin" response headers: the shim serves the site under
 * its REAL `https://<name>.gen` origin, so we DON'T downgrade. Strip only
 * hop-by-hop + `Proxy-*` + `Connection`-listed headers (Node re-frames the body)
 * and pass EVERYTHING else through verbatim — `Location`, HSTS, and `Secure`
 * cookies are all left intact for the remote shim to map `.test`⇄`.gen`. This is
 * the minimal host-side change that lets Phase D drop Phase C's downgrade rewrites
 * without duplicating them.
 */
export function passthroughResponseHeaders(
    upstream: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    const connTokens = connectionTokens(upstream['connection']);
    for (const [k, v] of Object.entries(upstream)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (connTokens.has(lk)) continue;
        out[k] = v;
    }
    return out;
}

/** PURE. Remove the `Secure` attribute from one `Set-Cookie` value. */
export function clearSecureCookie(cookie: string): string {
    return cookie
        .split(';')
        .filter((part) => part.trim().toLowerCase() !== 'secure')
        .join(';');
}

/** The lowercased header names a `Connection` header marks hop-by-hop. */
function connectionTokens(connection: string | string[] | undefined): Set<string> {
    const raw = Array.isArray(connection) ? connection.join(',') : connection ?? '';
    return new Set(
        raw
            .toLowerCase()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

// --- audit (first request per site) ----------------------------------------

/** siteIds we've already logged `site.open` for this run (once per site). */
const openedSites = new Set<string>();

function recordOpen(siteId: string, hostname: string, token: string): void {
    if (openedSites.has(siteId)) return;
    openedSites.add(siteId);
    audit('site.open', hostname, token.slice(0, 8));
}

/** Reset module state (test-only). */
export function _resetSiteProxyForTest(): void {
    openedSites.clear();
}

// --- HTTP entry ------------------------------------------------------------

/**
 * Handle one `/api/site/<siteId>/<path…>` HTTP request. Returns true once it has
 * taken over the response (so the server's static fallthrough is skipped). Runs
 * the full gate — token → kill-switch → master opt-in → allowlist resolve — then
 * streams the loopback upstream back to the remote.
 */
export async function handleSiteProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: SiteProxyDeps,
    info: SiteProxyInfo,
): Promise<boolean> {
    const parsed = parseSiteProxyUrl(req.url);
    if (!parsed) {
        sendError(res, 404, 'not found');
        return true;
    }

    // 1. Token gate (Bearer). Unauthed ⇒ 401.
    const session = sessionFromAuthHeader(req.headers['authorization']);
    if (!session) {
        sendError(res, 401, 'unauthorised');
        return true;
    }
    // 2. Kill-switch — 423 for ALL methods, incl. GET.
    if (isLocked()) {
        sendError(res, 423, 'locked — remote control is disabled on the desktop');
        return true;
    }
    // 3. Master opt-in (host-enforced here for the first time).
    if (!deps.localSitesEnabled()) {
        sendError(res, 403, 'local sites are disabled');
        return true;
    }
    // 4. Allowlist resolve — the opaque siteId is the ONLY selector; anything
    //    unknown / disabled / out-of-scope (or an SSRF attempt) is null → 404.
    const site = await deps.resolveSite(parsed.siteId);
    if (!site) {
        sendError(res, 404, 'unknown or disabled site');
        return true;
    }
    // 5. Audit the first hit per site.
    recordOpen(parsed.siteId, site.hostname, session.token);

    // Phase D: the remote shim serves the site under its real `https://<name>.gen`
    // origin and sets PRESERVE_ORIGIN_HEADER, so we SKIP the Phase-C http-downgrade
    // response rewrites and pass origin-bearing headers through for the shim to map.
    const preserveOrigin = req.headers[PRESERVE_ORIGIN_HEADER] !== undefined;
    proxyHttp(
        req,
        res,
        site,
        parsed.siteId,
        stripTokenParam(parsed.upstreamPath),
        info.proxyOrigin,
        preserveOrigin,
    );
    return true;
}

/** Dial the loopback upstream and STREAM the response back (never buffer). */
function proxyHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    site: ResolvedSite,
    siteId: string,
    upstreamPath: string,
    proxyOrigin: string,
    preserveOrigin: boolean,
): void {
    const isHttps = site.scheme === 'https';
    const options: https.RequestOptions = {
        host: LOOPBACK, // ALWAYS loopback — never the discovered IP or remote input
        port: site.port,
        method: req.method,
        path: upstreamPath,
        headers: buildUpstreamHeaders(req.headers, site.hostname),
        // §3(a): terminate the site's local TLS on loopback as a TLS CLIENT with
        // SNI = the vhost name. Loopback has no MITM surface, so an untrusted
        // (Herd) local cert is fine to accept.
        ...(isHttps ? { servername: site.hostname, rejectUnauthorized: false } : {}),
    };
    const agent = isHttps ? https : http;
    const upstream = agent.request(options, (upRes) => {
        const headers = preserveOrigin
            ? passthroughResponseHeaders(upRes.headers)
            : rewriteResponseHeaders(upRes.headers, site, siteId, proxyOrigin);
        res.writeHead(upRes.statusCode ?? 502, headers);
        upRes.pipe(res); // STREAM — assets, downloads, SSE never buffered
    });
    upstream.on('error', () => {
        if (!res.headersSent) sendError(res, 502, 'upstream error');
        else res.destroy();
    });
    // Tear the pairing down if either side goes away.
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    // Forward method + path + query + body VERBATIM.
    req.pipe(upstream);
}

// --- WebSocket upgrade entry ----------------------------------------------

/**
 * Handle a `/api/site/<siteId>/…` WS `upgrade` (HMR / Vite / Reverb / Echo).
 * Mirrors `/ws/term`: DNS-rebinding (origin) + token gate + kill-switch +
 * allowlist BEFORE accepting, then rewrites Host, dials loopback (TLS-terminated
 * with SNI for an https site), and pipes both directions.
 */
export async function handleSiteProxyUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    deps: SiteProxyDeps,
    info: { originAllowed: (req: http.IncomingMessage) => boolean },
): Promise<boolean> {
    const parsed = parseSiteProxyUrl(req.url);
    if (!parsed) {
        rejectSocket(socket, 404);
        return true;
    }
    const url = new URL(req.url ?? '/', 'http://genie-proxy-base.invalid');
    // Token from Bearer (programmatic) OR the namespaced query param (browser WS).
    const session =
        sessionFromAuthHeader(req.headers['authorization']) ??
        validateSession(url.searchParams.get(GENIE_TOKEN_PARAM));
    // DNS-rebinding + token gate BEFORE we accept the socket.
    if (!info.originAllowed(req) || !session) {
        rejectSocket(socket, 401);
        return true;
    }
    if (isLocked()) {
        rejectSocket(socket, 423);
        return true;
    }
    if (!deps.localSitesEnabled()) {
        rejectSocket(socket, 403);
        return true;
    }
    const site = await deps.resolveSite(parsed.siteId);
    if (!site) {
        rejectSocket(socket, 404);
        return true;
    }
    recordOpen(parsed.siteId, site.hostname, session.token);
    proxyUpgrade(req, socket, head, site, stripTokenParam(parsed.upstreamPath));
    return true;
}

/** Replay the upgrade to the loopback upstream and pipe the two sockets. */
function proxyUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    site: ResolvedSite,
    upstreamPath: string,
): void {
    const isHttps = site.scheme === 'https';
    const options: https.RequestOptions = {
        host: LOOPBACK,
        port: site.port,
        method: req.method ?? 'GET',
        path: upstreamPath,
        headers: buildUpstreamHeaders(req.headers, site.hostname, { keepUpgrade: true }),
        ...(isHttps ? { servername: site.hostname, rejectUnauthorized: false } : {}),
    };
    const agent = isHttps ? https : http;
    const upReq = agent.request(options);
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
        // Relay the upstream's 101 handshake verbatim (Sec-WebSocket-Accept was
        // computed from the client's key, which we forwarded) so the client's WS
        // validates it, then pipe both directions.
        socket.write(serializeHandshake(upRes));
        if (upHead && upHead.length) socket.write(upHead);
        if (head && head.length) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        const teardown = () => {
            upSocket.destroy();
            socket.destroy();
        };
        upSocket.on('error', teardown);
        socket.on('error', teardown);
        upSocket.on('close', teardown);
        socket.on('close', teardown);
    });
    upReq.on('error', () => rejectSocket(socket, 502));
    upReq.end();
}

/** Serialize an upstream upgrade response's status line + headers verbatim. */
function serializeHandshake(upRes: http.IncomingMessage): string {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    const rh = upRes.rawHeaders;
    for (let i = 0; i + 1 < rh.length; i += 2) lines.push(`${rh[i]}: ${rh[i + 1]}`);
    return `${lines.join('\r\n')}\r\n\r\n`;
}

// --- small response helpers ------------------------------------------------

const STATUS_TEXT: Record<number, string> = {
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    423: 'Locked',
    502: 'Bad Gateway',
};

function sendError(res: http.ServerResponse, status: number, error: string): void {
    const body = JSON.stringify({ error });
    try {
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    } catch {
        /* response already sent — nothing to do */
    }
}

/** Reject a WS upgrade with a bare status line, then close the raw socket. */
function rejectSocket(socket: Duplex, status: number): void {
    try {
        socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n\r\n`);
    } catch {
        /* socket already gone */
    }
    try {
        socket.destroy();
    } catch {
        /* already destroyed */
    }
}
