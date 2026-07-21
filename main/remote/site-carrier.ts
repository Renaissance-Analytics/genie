import http from 'node:http';
import https from 'node:https';
import { Duplex, PassThrough, type Readable } from 'node:stream';
import { TRANSPORT_TOKEN_HEADER } from '../mobile/site-proxy';
import { carrierHttpAgent, carrierHttpsAgent } from '../sites/local-carrier';
import type { SiteStreamController, SiteStreamHandlers } from './relay-mux';
import type { SiteOpenPayload } from './relay-protocol';

/**
 * The CARRIER seam for serve-local-sites (Phase E, design §2.0). The remote
 * forward-proxy shim (`site-proxy.ts`) operates on a plain HTTP/byte stream and
 * does NOT care what carries the host⟷remote hop under it. This module is that
 * carrier abstraction — one interface, two implementations:
 *
 *   - {@link createTailnetSiteCarrier} — DIRECT dial (Phase D). Opens
 *     `http(s).request` straight to the host's mobile-server base over the
 *     tailnet/LAN socket, injecting the Bearer IN MAIN. A fast WireGuard-E2E
 *     path when both peers share a tailnet.
 *   - {@link createRelaySiteCarrier} — RELAY (Phase E). Carries the same byte
 *     stream as `site` frames over the {@link RelayMemberClient}
 *     (`SiteStreamOpener`), so a remote with NO shared tailnet still reaches an
 *     enabled `*.gen` site. Works through any NAT (the host dials OUT to Tynn).
 *
 * `openTestingBrowser` picks the impl from the connection kind (`getSiteCarrier`
 * in `main/remote/index.ts`); the shim + `.gen` + session-CA stack above is
 * IDENTICAL on both, which is exactly what makes it carrier-agnostic.
 *
 * ═══ TRUST BOUNDARY — relay leg (design §2.0 + §8 open decision #4) ═══
 * The relay leg is `wss`/TLS end-to-end, BUT **Tynn (the relay) terminates TLS
 * and sees the site-proxy plaintext.** This is the accepted BASELINE for our own
 * SaaS: Tynn is trusted infra and already operates the path (cf. the headless
 * brief's "E2E-vs-Tynn is moot when Tynn operates the path"). The stronger
 * "blind relay" rung — WebRTC-DTLS or an app-layer key so the relay carries
 * CIPHERTEXT only, recovering the WireGuard-equivalent guarantee — is Phase F
 * and is deliberately NOT built here. The seam is left clean for it: a future
 * E2E carrier is just a THIRD `SiteCarrier` impl, no change to the shim above.
 *
 * ═══ Genie Cloud (GC-5) reuse ═══ Because the shim + host `site-proxy` + `.gen`
 * + session-CA are fully carrier-agnostic, a CLOUD-hosted Testing-Browser
 * session pointed at a workstation's `site-proxy` over the relay reuses this
 * stack UNCHANGED — this relay carrier IS the GC-5 preview-hosting primitive.
 */

// --- the carrier interface -------------------------------------------------

/** An HTTP request to forward over the carrier to the host's `/api/site/…`. */
export interface SiteForwardRequest {
    workspaceId: string;
    siteId: string;
    method: string;
    /** The host proxy path — `/api/site/<siteId>/<upstreamPath?query>`. */
    path: string;
    /** Forward headers built by the shim (preserve-origin set; NO Authorization —
     *  the carrier injects auth per-transport, keeping the token in MAIN). */
    headers: http.OutgoingHttpHeaders;
    /** The decrypted request body to stream upstream. */
    body: Readable;
}

/** The streamed response the carrier hands back to the shim. */
export interface SiteForwardResult {
    status: number;
    headers: http.IncomingHttpHeaders;
    /** The response body — STREAMED (assets/downloads/SSE never buffered). */
    body: Readable;
}

/** An in-flight forward: the streamed response + a hard abort (client gone). */
export interface SiteForwardCall {
    response: Promise<SiteForwardResult>;
    abort(): void;
}

/** A WS `upgrade` to forward over the carrier. */
export interface SiteUpgradeRequest {
    workspaceId: string;
    siteId: string;
    path: string;
    headers: http.OutgoingHttpHeaders;
}

/** The established upstream WS leg. */
export interface SiteUpgradeResult {
    /** The upstream's 101 status line + headers, verbatim (the client's WS
     *  validates the echoed `Sec-WebSocket-Accept`). */
    handshake: string;
    /** The upstream duplex — the shim pipes it with the client socket. */
    socket: Duplex;
    /** Any bytes buffered past the handshake (tailnet only; relay frames apart). */
    head?: Buffer;
}

/** An in-flight upgrade: the established leg + a hard abort. */
export interface SiteUpgradeCall {
    upgrade: Promise<SiteUpgradeResult>;
    abort(): void;
}

/** The carrier the shim forwards over — tailnet DIRECT or relay FRAMES. */
export interface SiteCarrier {
    forward(req: SiteForwardRequest): SiteForwardCall;
    upgradeWs(req: SiteUpgradeRequest): SiteUpgradeCall;
}

/** The minimal relay surface the relay carrier needs — `RelayMemberClient`
 *  satisfies it (its `openSite`). Kept as an interface so the carrier is
 *  transport-testable without a live `wss`. */
export interface SiteStreamOpener {
    openSite(open: SiteOpenPayload, handlers: SiteStreamHandlers): SiteStreamController;
}

// --- helpers ---------------------------------------------------------------

/**
 * Parse a host base URL into a dial target, PRESERVING the scheme.
 *
 * The scheme is load-bearing, not cosmetic: {@link hostHttpBase} yields
 * `https://<dnsName>:<port>` for a host with a real (Tailscale-issued) cert and
 * `http://<ip>:<port>` otherwise. Dropping it — as this used to — meant every
 * site dial went out over plain `http.request`, so a TLS host was dialled in
 * CLEARTEXT at its TLS port: a downgrade, and a broken connection.
 *
 * Default port follows the scheme (443 vs 80).
 */
export function parseBase(hostBase: string): { host: string; port: number; tls: boolean } {
    const u = new URL(hostBase);
    const tls = u.protocol === 'https:';
    return {
        host: u.hostname,
        port: u.port ? Number(u.port) : tls ? 443 : 80,
        tls,
    };
}

/** Serialize an upstream upgrade response's status line + headers verbatim. */
function serializeHandshake(res: http.IncomingMessage): string {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    const rh = res.rawHeaders;
    for (let i = 0; i + 1 < rh.length; i += 2) lines.push(`${rh[i]}: ${rh[i + 1]}`);
    return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Build a 101 handshake string from the relay's decomposed `{status, statusText,
 *  headers}` (the host sent the upstream's head as a frame, not raw bytes). */
function handshakeFromParts(
    status: number,
    statusText: string,
    headers: Record<string, string | string[]>,
): string {
    const lines = [`HTTP/1.1 ${status} ${statusText}`];
    for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
        else lines.push(`${k}: ${v}`);
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Flatten `OutgoingHttpHeaders` to the JSON-safe `Record<string, string|string[]>`
 *  the `site` frame carries (drop undefined, coerce numbers to strings). */
function flattenHeaders(headers: http.OutgoingHttpHeaders): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) out[k] = v.map(String);
        else out[k] = typeof v === 'number' ? String(v) : v;
    }
    return out;
}

// --- (a) tailnet DIRECT carrier (Phase D) ----------------------------------

/**
 * Direct-dial carrier: the Phase-D path, unchanged in behaviour. Opens
 * `http(s).request` to the host's mobile-server base and injects the Bearer IN
 * MAIN (never the renderer) — HTTP via the `Authorization` header, a WS via the
 * `?__genie_token=` param. `bearer` is read LAZILY so a token rotation is picked
 * up per call.
 */
export function createTailnetSiteCarrier(hostBase: string, bearer: () => string): SiteCarrier {
    const base = parseBase(hostBase);
    return {
        forward(req: SiteForwardRequest): SiteForwardCall {
            let upReq: http.ClientRequest | null = null;
            const response = new Promise<SiteForwardResult>((resolve, reject) => {
                const headers: http.OutgoingHttpHeaders = { ...req.headers };
                headers[TRANSPORT_TOKEN_HEADER] = bearer();
                // TLS when the host base says so — a host with a real cert is
                // dialled over https, never downgraded to cleartext. Dedicated
                // pool: the global agent's 5s idle window exactly matches Node's
                // default server.keepAliveTimeout, so a reused socket can be dead
                // on arrival with no retry to absorb it.
                upReq = (base.tls ? https : http).request(
                    {
                        agent: base.tls ? carrierHttpsAgent : carrierHttpAgent,
                        host: base.host,
                        port: base.port,
                        method: req.method,
                        path: req.path,
                        headers,
                    },
                    (upRes) => resolve({ status: upRes.statusCode ?? 502, headers: upRes.headers, body: upRes }),
                );
                upReq.on('error', reject);
                req.body.on('error', () => upReq?.destroy());
                req.body.pipe(upReq);
            });
            return { response, abort: () => upReq?.destroy() };
        },
        upgradeWs(req: SiteUpgradeRequest): SiteUpgradeCall {
            let upReq: http.ClientRequest | null = null;
            const upgrade = new Promise<SiteUpgradeResult>((resolve, reject) => {
                // Same TLS decision as forward(): a websocket upgrade to a TLS
                // host must ride wss, not be downgraded to ws.
                upReq = (base.tls ? https : http).request({
                    agent: base.tls ? carrierHttpsAgent : carrierHttpAgent,
                    host: base.host,
                    port: base.port,
                    method: 'GET',
                    path: req.path,
                    headers: { ...req.headers, [TRANSPORT_TOKEN_HEADER]: bearer() },
                });
                upReq.on('upgrade', (upRes, upSocket, upHead) =>
                    resolve({ handshake: serializeHandshake(upRes), socket: upSocket, head: upHead }),
                );
                upReq.on('error', reject);
                upReq.end();
            });
            return { upgrade, abort: () => upReq?.destroy() };
        },
    };
}

// --- (b) relay FRAMES carrier (Phase E) ------------------------------------

/**
 * Relay carrier: carries the site-proxy byte stream as `site` frames over the
 * member session ({@link SiteStreamOpener} = `RelayMemberClient.openSite`). NO
 * Bearer is injected here — the member holds NO host token; the grant that
 * established the relay session (in MAIN) authorizes it, and the host-side relay
 * dispatch self-pairs the workstation's mobile server when it hands the frame to
 * `handleSiteProxy` (exactly like the relay REST path, `relayRest`). So the
 * token still lives in MAIN on BOTH carriers — the tailnet Bearer here, the
 * grant+host-self-pair on the relay — never in a renderer.
 *
 * See the module trust-boundary note: Tynn sees this plaintext (baseline).
 */
export function createRelaySiteCarrier(opener: SiteStreamOpener): SiteCarrier {
    return {
        forward(req: SiteForwardRequest): SiteForwardCall {
            const body = new PassThrough();
            let done = false;
            let relayAbort: () => void = () => {};
            const response = new Promise<SiteForwardResult>((resolve, reject) => {
                const ctrl = opener.openSite(
                    {
                        workspaceId: req.workspaceId,
                        siteId: req.siteId,
                        method: req.method,
                        path: req.path,
                        headers: flattenHeaders(req.headers),
                        upgrade: false,
                    },
                    {
                        // A response head resolves; body chunks feed the PassThrough.
                        onResponse: (status, headers) => resolve({ status, headers, body }),
                        onData: (chunk) => body.write(chunk),
                        onClose: () => {
                            done = true;
                            body.end();
                            // A no-op if already resolved (the response completed);
                            // an early close before the head rejects the pending call.
                            reject(new Error('relay site stream closed before response'));
                        },
                        onError: (msg) => {
                            done = true;
                            body.destroy(new Error(msg));
                            reject(new Error(msg));
                        },
                    },
                );
                // Pump the request body upstream, then half-close.
                req.body.on('data', (c: Buffer) => ctrl.write(c));
                req.body.on('end', () => ctrl.end());
                req.body.on('error', () => {
                    done = true;
                    ctrl.close();
                });
                relayAbort = () => {
                    if (!done) {
                        done = true;
                        ctrl.close();
                    }
                };
            });
            return { response, abort: () => relayAbort() };
        },
        upgradeWs(req: SiteUpgradeRequest): SiteUpgradeCall {
            let duplex: RelaySiteDuplex | null = null;
            let done = false;
            let relayAbort: () => void = () => {};
            const upgrade = new Promise<SiteUpgradeResult>((resolve, reject) => {
                const ctrl = opener.openSite(
                    {
                        workspaceId: req.workspaceId,
                        siteId: req.siteId,
                        method: 'GET',
                        path: req.path,
                        headers: flattenHeaders(req.headers),
                        upgrade: true,
                    },
                    {
                        onUpgrade: (status, statusText, headers) => {
                            duplex = new RelaySiteDuplex(ctrl);
                            resolve({ handshake: handshakeFromParts(status, statusText, headers), socket: duplex });
                        },
                        onData: (chunk) => duplex?.pushIncoming(chunk),
                        onClose: () => {
                            done = true;
                            if (duplex) duplex.endIncoming();
                            else reject(new Error('relay site ws closed before upgrade'));
                        },
                        onError: (msg) => {
                            done = true;
                            // Tear the duplex down WITHOUT an error arg — the shim
                            // pipes it to the client socket and reacts to `close`;
                            // a `destroy(err)` with no 'error' listener would throw.
                            if (duplex) duplex.destroy();
                            else reject(new Error(msg));
                        },
                    },
                );
                relayAbort = () => {
                    if (!done) {
                        done = true;
                        ctrl.close();
                    }
                };
            });
            return { upgrade, abort: () => relayAbort() };
        },
    };
}

/**
 * A Duplex over a relay `site` stream for a WS `upgrade`: writes become
 * client→server `site` data frames; incoming server→client chunks are pushed to
 * the readable side. The shim pipes this exactly like a tailnet upstream socket.
 */
class RelaySiteDuplex extends Duplex {
    constructor(private readonly ctrl: SiteStreamController) {
        super();
    }
    _read(): void {
        /* push-driven — data arrives via pushIncoming */
    }
    _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        this.ctrl.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
    }
    _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
        this.ctrl.close();
        cb(err);
    }
    /** Feed a server→client chunk to the readable side. */
    pushIncoming(chunk: Buffer): void {
        this.push(chunk);
    }
    /** Signal the upstream closed — end the readable side. */
    endIncoming(): void {
        this.push(null);
    }
}
