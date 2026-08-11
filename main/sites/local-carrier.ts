import http from 'node:http';
import https from 'node:https';
import { Duplex, Readable, Transform } from 'node:stream';
import {
    buildUpstreamHeaders,
    parseSiteProxyUrl,
    stripTokenParam,
} from '../mobile/site-proxy';
import type { SiteScheme } from './gen-url';
import type {
    SiteCarrier,
    SiteForwardCall,
    SiteForwardRequest,
    SiteUpgradeCall,
    SiteUpgradeRequest,
} from '../remote/site-carrier';

/**
 * The LOCAL {@link SiteCarrier} — the same-machine analogue of the tailnet/relay
 * carriers. It lets the Testing Browser reach THIS machine's own loopback dev
 * sites (so a local `.gen` opens in the full browser chrome, with a green lock,
 * exactly like a remote one) WITHOUT any host connection, token, or relay.
 *
 * Where the tailnet carrier forwards `/api/site/<siteId>/…` over a socket to a
 * host's site-proxy, this carrier IS the site-proxy's loopback dial, in-process:
 * it resolves the `siteId` to its local target and dials `127.0.0.1` directly —
 * reusing the host proxy's PURE helpers (`parseSiteProxyUrl`, `stripTokenParam`,
 * `buildUpstreamHeaders`) so the two paths stay byte-identical.
 */

const LOOPBACK = '127.0.0.1';

/**
 * Idle keep-alive window for carrier dials, deliberately BELOW the 5000 ms that
 * is both Node's `http.globalAgent` default and its `server.keepAliveTimeout`
 * default.
 *
 * Those two being equal is a race: the upstream closes an idle connection at the
 * same instant the agent hands that socket to a new request, the write lands on
 * a dead socket, and the dial fails with ECONNRESET. The carriers used the bare
 * `http` / `https` modules — i.e. the shared global pool — and had no retry, so
 * the reset became a hard 502.
 *
 * That surfaced as a `.gen` dev site intermittently failing a chunk load
 * ("Failed to fetch dynamically imported module") or dropping an HMR socket in
 * the Testing Browser, and as two tests written off as flaky (site-shim under
 * full-suite load, tunnel.spec on the slowest CI runner).
 *
 * Expiring our side first means we never offer a socket the upstream may have
 * already closed. Dedicated agents (not the global pool) also stop unrelated
 * traffic from poisoning these dials.
 */
export const CARRIER_IDLE_TIMEOUT_MS = 2_000;

/** Node's default for BOTH `http.globalAgent.timeout` and
 *  `http.Server.keepAliveTimeout`. Their equality is the race; exported so the
 *  test can assert our window is STRICTLY below it. */
export const NODE_DEFAULT_IDLE_TIMEOUT_MS = 5_000;

/** Dedicated pools for carrier dials — never `globalAgent`. */
export const carrierHttpAgent = new http.Agent({
    keepAlive: true,
    timeout: CARRIER_IDLE_TIMEOUT_MS,
});
export const carrierHttpsAgent = new https.Agent({
    keepAlive: true,
    timeout: CARRIER_IDLE_TIMEOUT_MS,
});

/** A local dev site's loopback target — resolved from the enabled-site set. */
export interface LocalTarget {
    scheme: SiteScheme;
    /** The vhost name to force into `Host` (and TLS SNI for https). */
    hostname: string;
    /** The loopback port to dial. */
    port: number;
    loopback?: '127.0.0.1' | '::1';
}

/** Split `/api/site/<siteId><path>` and resolve the target it selects. */
function resolveForward(
    path: string,
    resolve: (siteId: string) => LocalTarget | null,
): { target: LocalTarget; upstreamPath: string } | null {
    const parsed = parseSiteProxyUrl(path);
    if (!parsed) return null;
    const target = resolve(parsed.siteId);
    if (!target) return null;
    return { target, upstreamPath: stripTokenParam(parsed.upstreamPath) };
}

/**
 * Content types whose body is text we can safely rewrite. Binary bodies (images,
 * fonts, wasm, octet-stream) are passed through untouched.
 */
export function isRewritableTextType(contentType: string | undefined): boolean {
    if (!contentType) return false;
    const ct = contentType.toLowerCase();
    return (
        ct.startsWith('text/') ||
        ct.includes('javascript') ||
        ct.includes('json') ||
        ct.includes('xml') || // application/xml, xhtml+xml, image/svg+xml
        ct.includes('html')
    );
}

/**
 * A streaming transform that rewrites every `http://<host>` → `https://<host>`,
 * correct ACROSS chunk boundaries — the in-process twin of the external host
 * Caddy's `replace { "http://<host>" "https://<host>" }` (host-caddyfile.ts).
 * Scoped to the site's OWN gen host so third-party URLs are never touched. Works
 * on raw bytes (the needle is ASCII) so it can't split a multi-byte UTF-8 char.
 */
export function createGenHttpsBodyRewriter(host: string): Transform {
    const needle = Buffer.from(`http://${host}`, 'latin1');
    const replacement = Buffer.from(`https://${host}`, 'latin1');
    let pending = Buffer.alloc(0);
    return new Transform({
        transform(chunk: Buffer, _enc, cb) {
            const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            const parts: Buffer[] = [];
            let from = 0;
            let at: number;
            while ((at = buf.indexOf(needle, from)) !== -1) {
                parts.push(buf.subarray(from, at), replacement);
                from = at + needle.length;
            }
            // The remaining [from, end) has no COMPLETE needle; any INCOMPLETE one
            // is a suffix ≤ needle.length-1 long, so hold back that many bytes for
            // the next chunk and emit the rest.
            const keep = Math.min(needle.length - 1, buf.length - from);
            const cut = buf.length - keep;
            parts.push(buf.subarray(from, cut));
            pending = Buffer.from(buf.subarray(cut)); // copy: detach from `buf`
            cb(null, Buffer.concat(parts));
        },
        flush(cb) {
            cb(null, pending);
        },
    });
}

/** Upgrade a `Location` that points at THIS gen host from http → https. */
export function upgradeGenLocation(location: string, host: string): string {
    const prefix = `http://${host}`;
    if (location.toLowerCase().startsWith(prefix.toLowerCase())) {
        return `https://${host}${location.slice(prefix.length)}`;
    }
    return location;
}

/** Build the loopback dial options for a target + upstream path/headers. */
function dialOptions(
    target: LocalTarget,
    upstreamPath: string,
    headers: http.OutgoingHttpHeaders,
    keepUpgrade: boolean,
): https.RequestOptions {
    const isTls = target.scheme === 'https';
    const upstreamHeaders = buildUpstreamHeaders(headers as http.IncomingHttpHeaders, target.hostname, {
        keepUpgrade,
        preserveApplicationAuthorization: true,
        // The carrier IS the https-terminating reverse proxy for `.gen`: the
        // Testing Browser reaches it over `https://<name>.gen`, and it then
        // dials the loopback target. A CONTAINER site's Caddy re-derives these,
        // but a HOST-NATIVE dev server is dialled DIRECTLY (plain http, no
        // Caddy) — so without these a proxy-trusting app sees plain http and
        // builds `http://<name>.gen` links the Testing Browser blocks. `proto` is
        // always https because the browser always reached the carrier over https
        // at `.gen`, whatever the upstream hop.
        forwarded: { proto: 'https', host: target.hostname, for: LOOPBACK },
    });
    // Strip Accept-Encoding on the forward path so the upstream returns a PLAINTEXT
    // body the https backstop (createGenHttpsBodyRewriter) can rewrite — mirrors the
    // host Caddy's `header_up -Accept-Encoding`. WS upgrades don't get rewritten.
    if (!keepUpgrade) delete upstreamHeaders['accept-encoding'];
    return {
        // Dedicated pool with an idle window below the upstream's — see
        // CARRIER_IDLE_TIMEOUT_MS. Never the global agent.
        agent: isTls ? carrierHttpsAgent : carrierHttpAgent,
        host: target.loopback ?? LOOPBACK, // validated literal loopback only
        port: target.port,
        method: keepUpgrade ? 'GET' : undefined,
        path: upstreamPath,
        headers: upstreamHeaders,
        // Terminate the dev site's local TLS as a client with SNI = the vhost;
        // loopback has no MITM surface, so a self-signed .test cert is fine.
        // codeql[js/disabling-certificate-validation]
        ...(isTls ? { servername: target.hostname, rejectUnauthorized: false } : {}),
    };
}

export function createLocalSiteCarrier(
    resolve: (siteId: string) => LocalTarget | null,
): SiteCarrier {
    return {
        forward(req: SiteForwardRequest): SiteForwardCall {
            let upReq: http.ClientRequest | null = null;
            const response = new Promise((resolve2, reject) => {
                const r = resolveForward(req.path, resolve);
                if (!r) {
                    reject(new Error('unknown or disabled local site'));
                    return;
                }
                const isTls = r.target.scheme === 'https';
                const agent = isTls ? https : http;
                const opts = dialOptions(r.target, r.upstreamPath, req.headers, false);
                opts.method = req.method;
                const host = r.target.hostname;
                upReq = agent.request(opts, (upRes) => {
                    // Site-agnostic https backstop (parity with the external host
                    // Caddy): force the app's own http self-links + redirects to
                    // https so a non-proxy-trusting stack's `http://<name>.gen`
                    // URLs don't hit the Testing Browser's https-only block.
                    const headers: http.IncomingHttpHeaders = { ...upRes.headers };
                    if (typeof headers.location === 'string') {
                        headers.location = upgradeGenLocation(headers.location, host);
                    }
                    let body: Readable = upRes;
                    if (isRewritableTextType(headers['content-type']) && !headers['content-encoding']) {
                        delete headers['content-length']; // the rewrite changes the length
                        const rewriter = createGenHttpsBodyRewriter(host);
                        upRes.on('error', (e) => rewriter.destroy(e));
                        body = upRes.pipe(rewriter);
                    }
                    resolve2({ status: upRes.statusCode ?? 502, headers, body });
                });
                upReq.on('error', reject);
                req.body.on('error', () => upReq?.destroy());
                req.body.pipe(upReq);
            }) as SiteForwardCall['response'];
            return { response, abort: () => upReq?.destroy() };
        },
        upgradeWs(req: SiteUpgradeRequest): SiteUpgradeCall {
            let upReq: http.ClientRequest | null = null;
            const upgrade = new Promise((resolve2, reject) => {
                const r = resolveForward(req.path, resolve);
                if (!r) {
                    reject(new Error('unknown or disabled local site'));
                    return;
                }
                const isTls = r.target.scheme === 'https';
                const agent = isTls ? https : http;
                upReq = agent.request(dialOptions(r.target, r.upstreamPath, req.headers, true));
                upReq.on('upgrade', (upRes, upSocket: Duplex, upHead: Buffer) =>
                    resolve2({ handshake: serializeHandshake(upRes), socket: upSocket, head: upHead }),
                );
                upReq.on('error', reject);
                upReq.end();
            }) as SiteUpgradeCall['upgrade'];
            return { upgrade, abort: () => upReq?.destroy() };
        },
    };
}

/** Serialize an upstream 101 handshake's status line + headers verbatim. */
function serializeHandshake(res: http.IncomingMessage): string {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    const rh = res.rawHeaders;
    for (let i = 0; i + 1 < rh.length; i += 2) lines.push(`${rh[i]}: ${rh[i + 1]}`);
    return `${lines.join('\r\n')}\r\n\r\n`;
}
