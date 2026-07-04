import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { SITE_PROXY_PREFIX, PRESERVE_ORIGIN_HEADER } from '../mobile/site-proxy';
import type { SessionCa } from './site-ca';
import type { SiteCarrier } from './site-carrier';

/**
 * REMOTE-side forward-proxy shim for the Testing Browser (serve-local-sites Phase
 * D, design §4). ONE shim per HOST connection.
 *
 * The Testing Browser's dedicated Electron `session` points at this shim via
 * `session.setProxy({ proxyRules: '127.0.0.1:<port>' })`. The shim:
 *   1. RESOLVES `*.gen` → the tunnel. A browser navigation to `https://tynn.gen`
 *      arrives as `CONNECT tynn.gen:443`. We accept it ONLY when the name is an
 *      ENABLED `.gen` for this connection (the injected `resolveGen`), then
 *      MITM-TERMINATE TLS with a leaf the session CA (site-ca.ts) signs — so the
 *      browser gets a real `https://tynn.gen` with a green lock + secure context.
 *   2. FORWARDS the decrypted HTTP/WS over the injected {@link SiteCarrier}
 *      (Phase E) to the host's `/api/site/<siteId>/<path…>` endpoint. The carrier
 *      is transport-agnostic: `tailnet` dials the host directly (Phase D),
 *      `relay` carries the byte stream as frames over the Tynn relay (Phase E) so
 *      a remote with NO shared tailnet still reaches the site. Either way the auth
 *      stays IN MAIN — the tailnet carrier injects the Bearer / `?__genie_token=`,
 *      the relay carrier rides the grant + host self-pair — never in the renderer.
 *      HTTP is streamed; WebSocket `upgrade` is passed through the same carrier.
 *   3. REFUSES everything not in the enabled `.gen` set — a non-`.gen` host, or a
 *      disabled/unknown `.gen`, is rejected at CONNECT (403) and again in the SNI
 *      callback + per-request. This is the §5 SSRF/allowlist boundary on the
 *      remote side: the shim is NOT a general internet proxy.
 *
 * ORIGIN COHERENCE (design §4, replacing Phase C's http-downgrade): because the
 * browser now sees a real `https://<name>.gen`, we map the upstream origin
 * `<hostname>.test ⇄ <name>.gen` PRESERVING https — rewriting `Location:` and
 * `Set-Cookie` `Domain=` to the `.gen` name while KEEPING HSTS + `Secure` cookies
 * (the secure context is valid). The shim sets {@link PRESERVE_ORIGIN_HEADER} so
 * the host proxy SKIPS its Phase-C http-downgrade rewrites on this path — the two
 * ends don't both rewrite. Body absolute-URL rewriting stays out of scope (the
 * `.gen` origin makes root-relative URLs resolve correctly).
 *
 * PER-CONNECTION ISOLATION (design decision #2 / the §7 analogue): each host
 * connection gets its OWN shim + OWN `SessionCa` + OWN Electron session, so
 * `tynn.gen` on hostA and `tynn.gen` on hostB resolve in separate `.gen` spaces
 * with separate CAs — no collision, the same name unambiguous on two hosts.
 */

// --- constants -------------------------------------------------------------

/** Hop-by-hop headers (RFC 7230 §6.1) + the `Proxy-*` family — stripped on BOTH
 *  legs. `Upgrade`/`Connection` are kept for a WebSocket handshake (keepUpgrade). */
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

/** A resolved ENABLED `.gen` target: its opaque host-side `siteId` (the URL
 *  selector) + the upstream `.test` hostname (for the `.test`⇄`.gen` rewrite). */
export interface GenTarget {
    siteId: string;
    /** The upstream loopback vhost name (e.g. `tynn.test`) the `.gen` maps to. */
    hostname: string;
}

/** The injected deps for one shim — all read in MAIN, nothing in the renderer. */
export interface SiteShimDeps {
    /** The per-session Genie CA that signs the `*.gen` leaf certs. */
    ca: SessionCa;
    /**
     * Resolve a `.gen` host → its enabled target, SYNCHRONOUSLY (so the CONNECT
     * gate + SNI callback stay synchronous). Returns null for a non-`.gen` host or
     * a disabled/unknown `.gen` — THE allowlist. Back it with a snapshot the
     * Testing Browser refreshes from the host's `/api/sites` (enabled rows only).
     */
    resolveGen: (genHost: string) => GenTarget | null;
    /**
     * The carrier that forwards the decrypted stream to the host's site-proxy —
     * `tailnet` (direct dial) or `relay` (frames over the Tynn relay). Picked from
     * the connection kind by `getSiteCarrier` (`main/remote/index.ts`); the shim's
     * mechanics above are identical on either. The carrier owns per-transport auth
     * injection (Bearer / grant), so the token never leaves MAIN.
     */
    carrier: SiteCarrier;
}

/** A running shim: its loopback proxy address + a clean shutdown. */
export interface SiteShim {
    /** The ephemeral port on 127.0.0.1 the browser session proxies through. */
    port: number;
    /** `127.0.0.1:<port>` — ready for `session.setProxy({ proxyRules })`. */
    proxyRules: string;
    close(): Promise<void>;
}

// --- pure helpers (unit-testable) ------------------------------------------

/** PURE. Lowercased hostname with any `:port` stripped. `''` for undefined. */
export function stripHostPort(host: string | undefined): string {
    if (!host) return '';
    const h = host.trim().toLowerCase();
    // A bracketed IPv6 literal has colons inside; `.gen` names never do, so a
    // simple last-colon split is safe here (we only ever handle `.gen` names).
    const colon = h.lastIndexOf(':');
    return colon > 0 && !h.includes(']') ? h.slice(0, colon) : h;
}

/** PURE. Is this a Genie tunnel name? (`*.gen`, Genie-resolved only.) */
export function isGenHost(host: string): boolean {
    return host.length > 4 && host.endsWith('.gen');
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

/**
 * PURE. Rewrite one `Location` for the `.test`⇄`.gen` origin map, PRESERVING the
 * scheme (https). Only the site's OWN origin is mapped (`https://tynn.test/…` →
 * `https://tynn.gen/…`); a cross-site absolute redirect is left as-is, and
 * root-relative / relative targets are left untouched (the `.gen` origin resolves
 * them correctly — no Phase-C prefixing).
 */
export function rewriteGenLocation(location: string, hostname: string, genHost: string): string {
    const loc = location.trim();
    if (!loc) return location;
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(loc)) {
        try {
            const u = new URL(loc, 'http://genie-shim-base.invalid');
            if (u.hostname.toLowerCase() === hostname.toLowerCase()) {
                u.hostname = genHost;
                return u.toString();
            }
            return loc; // different host — not ours to rewrite
        } catch {
            return loc;
        }
    }
    return location; // root-relative / relative — the .gen origin resolves it
}

/**
 * PURE. Rewrite a `Set-Cookie` `Domain=` from the upstream `.test` name to the
 * `.gen` name (preserving a leading dot), so a domain-scoped cookie is accepted by
 * the browser under `tynn.gen`. Everything else (`Secure`, `HttpOnly`, `SameSite`,
 * `Path`, expiry) is preserved verbatim — the secure context is valid, so we do
 * NOT clear `Secure` (that was Phase C's http-downgrade behaviour). A host-only
 * cookie (no `Domain`) is left untouched.
 */
export function rewriteGenSetCookieDomain(cookie: string, hostname: string, genHost: string): string {
    const lowerHost = hostname.toLowerCase();
    return cookie
        .split(';')
        .map((part) => {
            const eq = part.indexOf('=');
            if (eq === -1) return part;
            const name = part.slice(0, eq).trim().toLowerCase();
            if (name !== 'domain') return part;
            const rawVal = part.slice(eq + 1).trim();
            const dot = rawVal.startsWith('.');
            const bare = (dot ? rawVal.slice(1) : rawVal).toLowerCase();
            if (bare !== lowerHost) return part; // a different domain — leave it
            // Preserve the original spacing style (`Domain=` vs `domain=`) loosely.
            return part.slice(0, eq + 1) + (dot ? '.' : '') + genHost;
        })
        .join(';');
}

/**
 * PURE. Build the forward-request headers for the leg to the host proxy: copy the
 * inbound (decrypted) headers, but DROP `Host` (Node sets it from the dial
 * target), DROP `Authorization` (we inject the Genie Bearer — never forward a
 * site's own auth), and strip hop-by-hop + `Proxy-*` + any `Connection`-listed
 * header. `keepUpgrade` preserves `Upgrade`/`Connection` for a WS handshake. The
 * Bearer + {@link PRESERVE_ORIGIN_HEADER} are added by the caller (they hold the
 * token, kept out of this pure fn).
 */
export function buildForwardHeaders(
    inbound: http.IncomingHttpHeaders,
    opts: { keepUpgrade?: boolean } = {},
): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    const connTokens = connectionTokens(inbound['connection']);
    for (const [k, v] of Object.entries(inbound)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (lk === 'host') continue; // Node sets Host from the dial target
        if (lk === 'authorization') continue; // we inject the Genie Bearer instead
        if (lk.startsWith('proxy-')) continue;
        if (HOP_BY_HOP.has(lk)) {
            if (opts.keepUpgrade && (lk === 'upgrade' || lk === 'connection')) out[k] = v;
            continue;
        }
        if (connTokens.has(lk)) continue;
        out[k] = v;
    }
    return out;
}

/**
 * PURE. Rewrite the host proxy's RESPONSE headers for the browser: strip
 * hop-by-hop + `Proxy-*` + `Connection`-listed (let Node re-frame the body),
 * rewrite `Location` + `Set-Cookie` `Domain=` for the `.test`⇄`.gen` map, and KEEP
 * everything else — crucially HSTS and `Secure` cookies (the `https://<name>.gen`
 * secure context is real). The host proxy already SKIPPED its Phase-C rewrites
 * (we set {@link PRESERVE_ORIGIN_HEADER}), so this is the single origin rewrite.
 */
export function buildForwardResponseHeaders(
    upstream: http.IncomingHttpHeaders,
    hostname: string,
    genHost: string,
): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    const connTokens = connectionTokens(upstream['connection']);
    for (const [k, v] of Object.entries(upstream)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (connTokens.has(lk)) continue;
        if (lk === 'location') {
            out[k] = rewriteGenLocation(String(v), hostname, genHost);
            continue;
        }
        if (lk === 'set-cookie') {
            const cookies = Array.isArray(v) ? v : [String(v)];
            out[k] = cookies.map((c) => rewriteGenSetCookieDomain(c, hostname, genHost));
            continue;
        }
        out[k] = v; // HSTS, content-type, Secure cookies, etc. all preserved
    }
    return out;
}

/** PURE. The `/api/site/<siteId><path>` request path on the host proxy, with the
 *  browser's root-relative path/query appended verbatim. */
export function forwardPath(siteId: string, rawUrl: string | undefined): string {
    const rest = rawUrl && rawUrl.length ? rawUrl : '/';
    return `${SITE_PROXY_PREFIX}${siteId}${rest}`;
}

// --- the shim server -------------------------------------------------------

/**
 * Create + start ONE forward-proxy shim on `127.0.0.1:<ephemeral>`. Returns the
 * loopback address for `session.setProxy` and a clean shutdown. Everything the
 * shim does — the allowlist gate, the MITM leaf, the Bearer injection — happens in
 * MAIN; the renderer never sees the token or the CA key.
 */
export async function createSiteShim(deps: SiteShimDeps): Promise<SiteShim> {
    const liveSockets = new Set<Duplex>();

    // The internal MITM server: it TLS-terminates each accepted CONNECT tunnel
    // (via SNICallback → a session-CA leaf) and parses the decrypted HTTP/WS. It
    // is NEVER `.listen()`ed — we feed it sockets from the CONNECT handler.
    const defaultLeaf = deps.ca.issueLeaf('default.invalid'); // only for no-SNI TLS
    const mitm = https.createServer(
        {
            key: defaultLeaf.keyPem,
            cert: defaultLeaf.certPem,
            SNICallback: (servername, cb) => {
                const host = stripHostPort(servername);
                if (!isGenHost(host) || !deps.resolveGen(host)) {
                    cb(new Error('refused: not an enabled .gen site'));
                    return;
                }
                try {
                    const leaf = deps.ca.issueLeaf(host);
                    cb(null, tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem }));
                } catch (e) {
                    cb(e as Error);
                }
            },
        },
        (req, res) => onDecryptedRequest(req, res),
    );
    mitm.on('upgrade', (req, socket, head) => onDecryptedUpgrade(req, socket, head));
    mitm.on('clientError', (_err, socket) => {
        try {
            socket.destroy();
        } catch {
            /* already gone */
        }
    });

    function onDecryptedRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const genHost = stripHostPort(req.headers.host);
        const target = deps.resolveGen(genHost);
        if (!target) {
            sendError(res, 502, 'unknown or disabled .gen site');
            return;
        }
        // Build the forward headers (Authorization already dropped) + the
        // preserve-origin control signal; the CARRIER injects per-transport auth
        // (tailnet Bearer / relay grant), keeping the token in MAIN.
        const headers = buildForwardHeaders(req.headers);
        headers[PRESERVE_ORIGIN_HEADER] = '1';
        const call = deps.carrier.forward({
            method: req.method ?? 'GET',
            path: forwardPath(target.siteId, req.url),
            headers,
            body: req,
        });
        // Client gone (aborted upload / navigated away) ⇒ tear the carrier leg down.
        req.on('aborted', () => call.abort());
        res.on('close', () => call.abort());
        call.response
            .then(({ status, headers: upHeaders, body }) => {
                const outHeaders = buildForwardResponseHeaders(upHeaders, target.hostname, genHost);
                res.writeHead(status, outHeaders);
                body.on('error', () => {
                    try {
                        res.destroy();
                    } catch {
                        /* already gone */
                    }
                });
                body.pipe(res); // STREAM — assets, downloads, SSE never buffered
            })
            .catch(() => {
                if (!res.headersSent) sendError(res, 502, 'carrier error');
                else
                    try {
                        res.destroy();
                    } catch {
                        /* already gone */
                    }
            });
    }

    function onDecryptedUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
        const genHost = stripHostPort(req.headers.host);
        const target = deps.resolveGen(genHost);
        if (!target) {
            rejectSocket(socket, 502);
            return;
        }
        // The carrier owns WS auth (tailnet appends `?__genie_token=`; relay rides
        // the grant + host self-pair) so the Genie token never enters a renderer.
        const call = deps.carrier.upgradeWs({
            path: forwardPath(target.siteId, req.url),
            headers: buildForwardHeaders(req.headers, { keepUpgrade: true }),
        });
        socket.on('error', () => call.abort());
        call.upgrade
            .then(({ handshake, socket: upSocket, head: upHead }) => {
                socket.write(handshake);
                if (upHead && upHead.length) socket.write(upHead);
                if (head && head.length) upSocket.write(head);
                upSocket.pipe(socket);
                socket.pipe(upSocket);
                const teardown = () => {
                    try {
                        upSocket.destroy();
                    } catch {
                        /* gone */
                    }
                    try {
                        socket.destroy();
                    } catch {
                        /* gone */
                    }
                };
                upSocket.on('error', teardown);
                socket.on('error', teardown);
                upSocket.on('close', teardown);
                socket.on('close', teardown);
            })
            .catch(() => rejectSocket(socket, 502));
    }

    // The public proxy endpoint. HTTPS `.gen` navigations arrive as CONNECT; a
    // plain-http proxy request is REFUSED (we are not a general proxy).
    const proxy = http.createServer((req, res) => {
        sendError(res, 400, 'the Genie testing browser only tunnels https://*.gen');
    });
    proxy.on('connect', (req, clientSocket: Duplex, head: Buffer) => {
        const genHost = stripHostPort(req.url);
        // §5 allowlist: refuse everything not in the enabled `.gen` set — a
        // non-`.gen` host or a disabled/unknown `.gen` never gets a tunnel.
        if (!isGenHost(genHost) || !deps.resolveGen(genHost)) {
            rejectSocket(clientSocket, 403);
            return;
        }
        liveSockets.add(clientSocket);
        clientSocket.on('close', () => liveSockets.delete(clientSocket));
        clientSocket.on('error', () => {
            try {
                clientSocket.destroy();
            } catch {
                /* gone */
            }
        });
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) clientSocket.unshift(head);
        // Hand the raw socket to the MITM server → it does the TLS handshake
        // (SNICallback → session-CA leaf) and parses the decrypted stream.
        mitm.emit('connection', clientSocket);
    });

    await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(0, '127.0.0.1', () => {
            proxy.off('error', reject);
            resolve();
        });
    });
    const port = (proxy.address() as AddressInfo).port;

    return {
        port,
        proxyRules: `127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                for (const s of liveSockets) {
                    try {
                        s.destroy();
                    } catch {
                        /* gone */
                    }
                }
                liveSockets.clear();
                try {
                    mitm.close();
                } catch {
                    /* never listened */
                }
                proxy.close(() => resolve());
            }),
    };
}

// --- small helpers ---------------------------------------------------------

const STATUS_TEXT: Record<number, string> = {
    400: 'Bad Request',
    403: 'Forbidden',
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
        /* already sent */
    }
}

function rejectSocket(socket: Duplex, status: number): void {
    try {
        socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n\r\n`);
    } catch {
        /* gone */
    }
    try {
        socket.destroy();
    } catch {
        /* already destroyed */
    }
}
