import http from 'node:http';
import https from 'node:https';
import { Duplex } from 'node:stream';
import {
    buildUpstreamHeaders,
    parseSiteProxyUrl,
    stripTokenParam,
} from '../mobile/site-proxy';
import type { SiteScheme } from '../mobile/hosts';
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

/** A local dev site's loopback target — resolved from the enabled-site set. */
export interface LocalTarget {
    scheme: SiteScheme;
    /** The vhost name to force into `Host` (and TLS SNI for https). */
    hostname: string;
    /** The loopback port to dial. */
    port: number;
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

/** Build the loopback dial options for a target + upstream path/headers. */
function dialOptions(
    target: LocalTarget,
    upstreamPath: string,
    headers: http.OutgoingHttpHeaders,
    keepUpgrade: boolean,
): https.RequestOptions {
    const isTls = target.scheme === 'https';
    return {
        host: LOOPBACK, // ALWAYS loopback — the siteId is the only selector (SSRF-safe)
        port: target.port,
        method: keepUpgrade ? 'GET' : undefined,
        path: upstreamPath,
        headers: buildUpstreamHeaders(headers as http.IncomingHttpHeaders, target.hostname, {
            keepUpgrade,
            preserveApplicationAuthorization: true,
        }),
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
                upReq = agent.request(opts, (upRes) =>
                    resolve2({ status: upRes.statusCode ?? 502, headers: upRes.headers, body: upRes }),
                );
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
