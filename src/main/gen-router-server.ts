import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolveRoute, type GenRoute } from '../core/gen-router.js';

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
 * `node:http` only. Zero dependencies.
 */

export class GenRouterServer {
    readonly #routes: () => readonly GenRoute[];
    readonly #server: Server;

    constructor(routes: () => readonly GenRoute[]) {
        this.#routes = routes;
        this.#server = createServer((req, res) => this.#onRequest(req, res));
        this.#server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket as Socket, head));
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

    #onRequest(req: IncomingMessage, res: ServerResponse): void {
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
            { host, port: Number(portText), method: req.method, path: req.url, headers: { ...req.headers, host: route.host } },
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
        const route = resolveRoute(req.headers.host, this.#routes());
        if (route.kind !== 'site') {
            socket.end(`HTTP/1.1 ${route.kind === 'no-site' ? '404 Not Found' : '421 Misdirected Request'}\r\nConnection: close\r\n\r\n`);
            return;
        }
        const [host, portText] = route.target.split(':');
        const up = connect(Number(portText), host, () => {
            const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = req.rawHeaders[i]!;
                const value = name.toLowerCase() === 'host' ? route.host : req.rawHeaders[i + 1]!;
                lines.push(`${name}: ${value}`);
            }
            up.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head.length > 0) up.write(head);
            socket.pipe(up);
            up.pipe(socket);
        });
        up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
        socket.on('error', () => up.destroy());
    }
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:14px system-ui;margin:4rem auto;max-width:36rem;color:#e4e4e7;background:#18181b}code,strong{color:#fff}</style></head><body><h1>${escape(title)}</h1><p>${body}</p><p><small>Genie · .gen front door</small></p></body></html>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
}
