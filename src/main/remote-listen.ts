import { createServer as nodeCreateServer, type Server } from 'node:http';
import { createServer as nodeCreateSecureServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import { REMOTE_PATH, parseTailscaleStatus, remoteListenAddress } from '../core/tailscale.js';
import type { PageServer } from './static-page.js';
import { fancyWsTransport, type AttachWebSocketServer } from './ws-server-transport.js';

/**
 * WHERE THE HOST'S SOCKET LISTENS (§6.8). Binds fancy-ws to this machine's Tailscale IPv4 ONLY and
 * advertises the MagicDNS name: a device on the tailnet reaches it, nothing on the LAN or the internet
 * does, and the tailnet's WireGuard is the encryption. No Tailscale → NOTHING listens (no server is
 * even created) and `unavailable()` says why in words a person can act on. The host never falls back
 * to every interface. `tailscale` is a port: it resolves the stdout of `tailscale status --json`.
 */

export interface RemoteListenerInput {
    readonly tailscale: () => Promise<string>;
    /** 0 picks a free port (tests); the advertised URL always carries the port actually bound. */
    readonly port: number;
    readonly attach: AttachWebSocketServer;
    readonly createServer?: () => Server;
    /** The phone's page (§6.8): GET on this port serves the built renderer through it. Absent, the port serves nothing but the socket. */
    readonly serve?: PageServer;
    /**
     * HTTPS ON THE TAILNET NAME (genie#1346 — an installable app needs a secure context). A Tailscale cert for this node's
     * MagicDNS name (`tailscale cert`, Genie 1's main/mobile/tls.ts), or `null` when the tailnet gives none (MagicDNS or
     * HTTPS certificates off): then the port serves http, still inside WireGuard — Genie 1's fallback. Absent = http.
     */
    readonly cert?: (dnsName: string) => Promise<{ cert: string; key: string } | null>;
}

/** The listener's transport always answers where it listens and why not — never optional here. */
export interface ListeningTransport extends ServerTransport {
    address(): string | null;
    unavailable(): string | null;
}

export interface RemoteListener {
    readonly transport: ListeningTransport;
    /** Why nothing listens, or `null` while it does. */
    unavailable(): string | null;
    start(): Promise<void>;
    stop(): Promise<void>;
}

export function remoteListener(input: RemoteListenerInput): RemoteListener {
    let server: Server | null = null;
    let address: string | null = null;
    let reason: string | null = 'not started';
    const listeners = new Set<(connection: ServerConnection) => void>();
    const open = new Set<ServerConnection>();

    const transport: ListeningTransport = {
        onConnection: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        address: () => address,
        unavailable: () => reason,
    };

    return {
        transport,
        unavailable: () => reason,
        start: async () => {
            let json: string;
            try {
                json = await input.tailscale();
            } catch (error) {
                reason = `Tailscale is not installed or not on PATH (${error instanceof Error ? error.message : String(error)})`;
                return;
            }
            const status = parseTailscaleStatus(json);
            const where = remoteListenAddress(status, input.port);
            if (!where) {
                reason = status.ok ? `${status.ip} is not a Tailscale address (100.64.0.0/10); Genie listens only on the tailnet` : status.reason;
                return;
            }
            // A cert can only name the MagicDNS name, never the raw 100.x address, so HTTPS is addressed by the name.
            const dnsName = status.ok && status.dnsName !== status.ip ? status.dnsName : null;
            const tls = input.cert && dnsName ? await input.cert(dnsName).catch(() => null) : null;
            const s: Server = tls ? (nodeCreateSecureServer({ cert: tls.cert, key: tls.key }) as unknown as Server) : (input.createServer ?? nodeCreateServer)();
            // THE PHONE'S PAGE (§6.8) rides the same port: GET/HEAD for what `serve` allows, 405 for any other method,
            // 404 for everything else — and with no `serve`, 404 for everything: the port carries the socket alone.
            const serve = input.serve;
            s.on('request', (req, res) => {
                void (async () => {
                    if (!serve) { res.statusCode = 404; res.end(); return; }
                    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); res.end(); return; }
                    const served = await serve(req.url ?? '/');
                    if (!served) { res.statusCode = 404; res.end(); return; }
                    res.statusCode = 200;
                    res.setHeader('Content-Type', served.contentType);
                    res.setHeader('Cache-Control', served.cache);
                    res.setHeader('X-Content-Type-Options', 'nosniff');
                    for (const [k, v] of Object.entries(served.headers ?? {})) res.setHeader(k, v);
                    res.setHeader('Content-Length', served.body.byteLength);
                    if (req.method === 'HEAD') res.end();
                    else res.end(Buffer.from(served.body));
                })().catch(() => { res.statusCode = 500; res.end(); });
            });
            await new Promise<void>((resolve, reject) => {
                s.once('error', reject);
                s.listen(input.port, where.bind, () => { s.off('error', reject); resolve(); });
            });
            const port = (s.address() as AddressInfo).port;
            const url = where.url.replace(`:${input.port}${REMOTE_PATH}`, `:${port}${REMOTE_PATH}`).replace(/^ws:/, tls ? 'wss:' : 'ws:');
            const inner = fancyWsTransport({ attach: input.attach, server: s, path: REMOTE_PATH, address: () => address });
            inner.onConnection((c) => {
                open.add(c);
                c.onClose(() => { open.delete(c); });
                for (const l of listeners) l(c);
            });
            server = s;
            address = url;
            reason = null;
        },
        stop: async () => {
            address = null;
            reason = 'stopped';
            const s = server;
            server = null;
            if (!s) return;
            for (const c of open) c.close();
            open.clear();
            await new Promise<void>((resolve) => {
                s.close(() => resolve());
                s.closeAllConnections();
            });
        },
    };
}
