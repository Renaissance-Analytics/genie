import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { TLSSocket, type SecureContext } from 'node:tls';
import { absoluteFormAnswer, resolveConnect } from '../core/browser-origins.js';
import { normalizeHost, resolveRoute, type GenRoute } from '../core/gen-router.js';

/**
 * THE `.gen` FRONT DOOR (§6.6) — the byte-moving half.
 *
 * One loopback listener. Every request is resolved by `core/gen-router.ts` — this file never
 * decides anything about hosts or targets, it only moves bytes:
 *
 * - `site`     → proxied to the loopback target with the `.gen` Host kept and the path intact.
 * - `no-site`  → 404, a page that NAMES the host, so the person can see which name and create it.
 * - `not-gen`  → 421 Misdirected Request; the front door serves `.gen` and nothing else.
 * - a target that does not answer → 502 naming the site, never a hang.
 *
 * WebSocket upgrades pass through on the same socket, because a Vite dev server without HMR is
 * not the dev server the person started.
 *
 * THE GENIE BROWSER'S TUNNEL (S7): the pane's session sends `*.gen` here as its proxy, so the door
 * also answers `CONNECT <name>.gen:443` — for a site it serves, and nothing else — by terminating
 * TLS with Genie's leaf (`tls`, main/browser-trust.ts) and handing the decrypted stream to the
 * same request/upgrade handlers. A request inside a tunnel must name the tunnel's host (421
 * otherwise) and reaches the site with `X-Forwarded-Proto: https`, as the external Caddy sends.
 * A proxied plain-http `.gen` request is redirected to https; any other proxy use is refused.
 *
 * `node:http` only. Zero dependencies.
 */

export interface GenRouterOptions {
    /** The TLS context for a tunnel to this `.gen` host (Genie's leaf), or `null`: without one no tunnel is opened. */
    readonly tls?: (host: string) => SecureContext | null;
}

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 404: 'Not Found', 421: 'Misdirected Request', 502: 'Bad Gateway' };

export class GenRouterServer {
    readonly #routes: () => readonly GenRoute[];
    readonly #server: Server;
    readonly #tls: GenRouterOptions['tls'];
    /** The decrypted side of every open tunnel → the `.gen` host its CONNECT named. */
    readonly #tunnels = new WeakMap<object, string>();

    constructor(routes: () => readonly GenRoute[], options: GenRouterOptions = {}) {
        this.#routes = routes;
        this.#tls = options.tls;
        this.#server = createServer((req, res) => this.#onRequest(req, res));
        this.#server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket as Socket, head));
        this.#server.on('connect', (req, socket, head) => this.#onConnect(req, socket as Socket, head));
    }

    /** Loopback only. `port` 0 picks a free one; the chosen port is returned. */
    listen(port = 0): Promise<number> {
        return new Promise((resolve, reject) => {
            this.#server.once('error', reject);
            this.#server.listen(port, '127.0.0.1', () => {
                this.#server.off('error', reject);
                resolve((this.#server.address() as AddressInfo).port);
            });
        });
    }

    address(): AddressInfo | null {
        const a = this.#server.address();
        return a && typeof a === 'object' ? a : null;
    }

    close(callback?: () => void): void {
        this.#server.closeAllConnections?.();
        this.#server.close(() => callback?.());
    }

    #onConnect(req: IncomingMessage, socket: Socket, head: Buffer): void {
        socket.on('error', () => socket.destroy());
        const r = resolveConnect(req.url, this.#routes());
        if (r.kind === 'refused') {
            refuse(socket, r.status, r.reason);
            return;
        }
        let context: SecureContext | null = null;
        let why = 'Genie has no certificate for it';
        try {
            context = this.#tls?.(r.host) ?? null;
        } catch (error) {
            why = error instanceof Error ? error.message : String(error);
        }
        if (context === null) {
            refuse(socket, 502, `${r.host}: ${why}`);
            return;
        }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) socket.unshift(head);
        const secure = new TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'] });
        secure.on('error', () => secure.destroy());
        this.#tunnels.set(secure, r.host);
        this.#server.emit('connection', secure);
    }

    /** Inside a tunnel: the host its CONNECT named. `undefined` = a plain loopback request. */
    #tunnelOf(req: IncomingMessage): string | undefined {
        return this.#tunnels.get(req.socket);
    }

    #onRequest(req: IncomingMessage, res: ServerResponse): void {
        const tunnel = this.#tunnelOf(req);
        if (tunnel === undefined) {
            const form = absoluteFormAnswer(req.url ?? '/');
            if (form.kind === 'upgrade') {
                res.writeHead(308, { location: form.location, 'cache-control': 'no-store' });
                res.end();
                return;
            }
            if (form.kind === 'refused') {
                page(res, 421, 'Not served here', `This door serves <code>.gen</code> sites only.`);
                return;
            }
        } else if (normalizeHost(req.headers.host) !== tunnel) {
            page(res, 421, 'Misdirected Request', `This connection is for <strong>${escape(tunnel)}</strong>.`);
            return;
        }
        const route = resolveRoute(req.headers.host, this.#routes());
        if (route.kind === 'not-gen') {
            page(res, 421, 'Not served here', `This door serves <code>.gen</code> sites only.`);
            return;
        }
        if (route.kind === 'no-site') {
            page(res, 404, `No site at ${route.host}`, `Nothing is serving <strong>${escape(route.host)}</strong>. Create a site with that name in Genie, or check its process.`);
            return;
        }
        const [host, portText] = route.target.split(':');
        const upstream = request(
            { host, port: Number(portText), method: req.method, path: req.url, headers: { ...req.headers, host: route.host, ...(tunnel === undefined ? {} : forwarded(route.host)) } },
            (up) => {
                res.writeHead(up.statusCode ?? 502, up.headers);
                up.pipe(res);
            },
        );
        upstream.on('error', () => {
            if (!res.headersSent) page(res, 502, `${route.host} is not answering`, `The site <strong>${escape(route.host)}</strong> is registered but its process did not answer on ${escape(route.target)}. Start or restart it in Genie.`);
            else res.destroy();
        });
        req.pipe(upstream);
    }

    #onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
        const tunnel = this.#tunnelOf(req);
        if (tunnel !== undefined && normalizeHost(req.headers.host) !== tunnel) {
            socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
            return;
        }
        const route = resolveRoute(req.headers.host, this.#routes());
        if (route.kind !== 'site') {
            socket.end(`HTTP/1.1 ${route.kind === 'no-site' ? '404 Not Found' : '421 Misdirected Request'}\r\nConnection: close\r\n\r\n`);
            return;
        }
        const [host, portText] = route.target.split(':');
        const up = connect(Number(portText), host, () => {
            const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            const added: Record<string, string> = tunnel === undefined ? {} : forwarded(route.host);
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = req.rawHeaders[i]!;
                if (name.toLowerCase() in added) continue;
                const value = name.toLowerCase() === 'host' ? route.host : req.rawHeaders[i + 1]!;
                lines.push(`${name}: ${value}`);
            }
            for (const [name, value] of Object.entries(added)) lines.push(`${name}: ${value}`);
            up.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head.length > 0) up.write(head);
            socket.pipe(up);
            up.pipe(socket);
        });
        up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
        socket.on('error', () => up.destroy());
    }
}

/** What the site is told about a tunnelled request — the same three the external Caddy's reverse_proxy sends. */
function forwarded(host: string): Record<string, string> {
    return { 'x-forwarded-proto': 'https', 'x-forwarded-host': host, 'x-forwarded-for': '127.0.0.1' };
}

/** A refused CONNECT: a status line and the reason, then the socket closes. */
function refuse(socket: Socket, status: number, reason: string): void {
    const body = `${reason}\n`;
    socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Refused'}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:14px system-ui;margin:4rem auto;max-width:36rem;color:#e4e4e7;background:#18181b}code,strong{color:#fff}</style></head><body><h1>${escape(title)}</h1><p>${body}</p><p><small>Genie · .gen front door</small></p></body></html>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
}
