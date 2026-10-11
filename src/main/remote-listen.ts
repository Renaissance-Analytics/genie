import { createServer as nodeCreateServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import { REMOTE_PATH, parseTailscaleStatus, remoteListenAddress } from '../core/tailscale.js';
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
                reason = status.ok ? 'Tailscale gave no address to listen on' : status.reason;
                return;
            }
            const s = (input.createServer ?? nodeCreateServer)();
            // Anything that is not the socket upgrade gets a 404 — this port serves nothing else.
            s.on('request', (_req, res) => { res.statusCode = 404; res.end(); });
            await new Promise<void>((resolve, reject) => {
                s.once('error', reject);
                s.listen(input.port, where.bind, () => { s.off('error', reject); resolve(); });
            });
            const port = (s.address() as AddressInfo).port;
            const url = where.url.replace(`:${input.port}${REMOTE_PATH}`, `:${port}${REMOTE_PATH}`);
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
