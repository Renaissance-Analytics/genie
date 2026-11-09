import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { lstat, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { APP_CHANNEL_MAX_BYTES, APP_CHANNEL_PATH, appCsp, appHost } from '../core/gapp-origin.js';
import { normalizeHost, type GenRoute } from '../core/gen-router.js';
import type { GAppBridge } from './gapp-bridge.js';
import type { GAppBook, GAppEntry } from './gapps-host.js';

/**
 * SERVING AN INSTALLED GAPP (GApps v2, V4, Tynn #569; spec .ai/plans/specs/gapps-v2.md). One loopback listener behind the
 * `.gen` front door: each installed, turned-on app is a route, `<app-slug>.apps.gen`, its own origin (core/gapp-origin.ts).
 *
 * It serves the app's installed copy and nothing else: never a path outside those files, under a CSP of its own origin
 * and its granted hosts. The digest is checked again as the app's ENTRY page loads, so a file changed after install is
 * refused as tampered then (B4's re-check before running, for an app).
 *
 * THE APP CHANNEL: a WebSocket on the app's own origin. A session is minted for one window of one app, holding a token
 * only that window's sealed preload gets (main/gapp-window.ts). The first message says hello with it; a token that is not
 * for this app, or whose window closed, is refused. After that each message is a bridge call for that app and no other
 * (main/gapp-bridge.ts), and the bridge's events reach that app's windows.
 */
export interface GAppSession {
    readonly packageId: string;
    readonly url: string;
    readonly channel: string;
    readonly token: string;
    readonly window: Readonly<Record<string, unknown>>;
    close(): void;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};
const DEFAULT_WINDOW = { width: 1024, height: 720, resizable: true };

/** The request's path as segments inside the app, or null when it is not a plain path there. */
function segmentsOf(url: string): string[] | null {
    let path: string;
    try {
        path = decodeURIComponent(url.split(/[?#]/, 1)[0] ?? '');
    } catch {
        return null;
    }
    if (!path.startsWith('/') || /[\\\u0000]/.test(path)) return null;
    const segments = path.slice(1).split('/');
    return segments.every((s) => s !== '' && s !== '.' && s !== '..') ? segments : null;
}

function refuse(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(`${message}\n`);
}

export class GAppServer {
    readonly #book: Pick<GAppBook, 'list' | 'installedDir' | 'appElement' | 'verifyInstalled'>;
    readonly #server: Server;
    readonly #sockets: WebSocketServer;
    readonly #sessions = new Map<string, { packageId: string; socket: WebSocket | null }>();
    readonly #bridge: Pick<GAppBridge, 'handle' | 'onEvent'>;
    readonly #offBridge: () => void;
    #port = 0;

    constructor(input: { book: Pick<GAppBook, 'list' | 'installedDir' | 'appElement' | 'verifyInstalled'>; bridge: Pick<GAppBridge, 'handle' | 'onEvent'> }) {
        this.#book = input.book;
        this.#bridge = input.bridge;
        this.#offBridge = input.bridge.onEvent((packageId, event, data) => {
            for (const session of this.#sessions.values()) {
                if (session.packageId === packageId && session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ event, data }));
            }
        });
        this.#server = createServer((req, res) => { void this.#onRequest(req, res); });
        this.#sockets = new WebSocketServer({ noServer: true, maxPayload: APP_CHANNEL_MAX_BYTES });
        this.#server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    }

    listen(port = 0): Promise<number> {
        return new Promise((resolve, reject) => {
            this.#server.once('error', reject);
            this.#server.listen(port, '127.0.0.1', () => {
                this.#server.off('error', reject);
                this.#port = (this.#server.address() as AddressInfo).port;
                resolve(this.#port);
            });
        });
    }

    close(): Promise<void> {
        this.#offBridge();
        for (const session of this.#sessions.values()) session.socket?.terminate();
        this.#sessions.clear();
        this.#sockets.close();
        this.#server.closeAllConnections();
        return new Promise((resolve) => { this.#server.close(() => resolve()); });
    }

    /** Each installed, turned-on app's route, for the front door. */
    routes(): GenRoute[] {
        if (this.#port === 0) return [];
        return this.#book.list().filter((e) => e.state === 'installed').map((e) => ({ host: appHost(e.packageId), target: `127.0.0.1:${this.#port}` }));
    }

    /** A session for one window of one app: where it loads, its channel and its token. `null`: not an app that can open. */
    openSession(packageId: string): GAppSession | null {
        const entry = this.#book.list().find((e) => e.packageId === packageId && e.state === 'installed');
        const app = this.#book.appElement(packageId);
        if (!entry || !app) return null;
        const token = randomBytes(32).toString('base64url');
        this.#sessions.set(token, { packageId, socket: null });
        const host = appHost(packageId);
        return {
            packageId, token,
            url: `https://${host}/${String(app.payload.entry)}`,
            channel: `wss://${host}${APP_CHANNEL_PATH}`,
            window: { ...DEFAULT_WINDOW, ...(app.payload.window as Record<string, unknown> | undefined) },
            close: () => {
                const session = this.#sessions.get(token);
                this.#sessions.delete(token);
                session?.socket?.close();
            },
        };
    }

    #appAt(host: string | undefined): GAppEntry | null {
        const wanted = normalizeHost(host);
        return this.#book.list().find((e) => e.state === 'installed' && appHost(e.packageId) === wanted) ?? null;
    }

    async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const entry = this.#appAt(req.headers.host);
        const dir = entry ? this.#book.installedDir(entry.packageId) : null;
        const app = entry ? this.#book.appElement(entry.packageId) : null;
        if (!entry || !dir || !app) { refuse(res, 404, 'No app is served at this address.'); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET, HEAD'); refuse(res, 405, 'An app is served with GET and HEAD only.'); return; }
        const entryPath = String(app.payload.entry);
        const bare = (req.url ?? '/').split(/[?#]/, 1)[0];
        if (bare === '/') {
            res.writeHead(302, { location: `/${entryPath}`, 'cache-control': 'no-store' });
            res.end();
            return;
        }
        const segments = segmentsOf(req.url ?? '/');
        if (!segments) { refuse(res, 404, 'Not found.'); return; }
        const relative = segments.join('/');
        if (relative === entryPath) {
            const problem = await this.#book.verifyInstalled(entry.packageId);
            if (problem) { refuse(res, 403, problem); return; }
        }
        const file = join(dir, ...segments);
        try {
            if (!(await lstat(file)).isFile()) { refuse(res, 404, 'Not found.'); return; }
            const body = await readFile(file);
            res.writeHead(200, {
                'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
                'content-security-policy': appCsp(entry.grant.network),
                'x-content-type-options': 'nosniff',
                'cache-control': 'no-cache',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
            refuse(res, 404, 'Not found.');
        }
    }

    #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const entry = this.#appAt(req.headers.host);
        const path = (req.url ?? '').split(/[?#]/, 1)[0];
        const origin = req.headers.origin;
        if (!entry || path !== APP_CHANNEL_PATH || (origin !== undefined && origin !== `https://${appHost(entry.packageId)}`)) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }
        this.#sockets.handleUpgrade(req, socket, head, (ws) => {
            ws.once('message', (data) => this.#hello(ws, entry.packageId, data.toString()));
        });
    }

    #hello(ws: WebSocket, packageId: string, text: string): void {
        const refused = (reason: string) => { ws.send(JSON.stringify({ ok: false, reason })); ws.close(); };
        let token: unknown;
        try { token = (JSON.parse(text) as { hello?: unknown }).hello; } catch { token = undefined; }
        const session = typeof token === 'string' ? this.#sessions.get(token) : undefined;
        if (!session) { refused('this token is not a live window of this Genie'); return; }
        if (session.packageId !== packageId) { refused('this token is not for this app'); return; }
        session.socket = ws;
        ws.on('message', (data) => { void this.#call(ws, packageId, data.toString()); });
        ws.send(JSON.stringify({ ok: true, packageId }));
    }

    /** One bridge call on a window's channel. The app is the one its token was minted for, never one the message names. */
    async #call(ws: WebSocket, packageId: string, text: string): Promise<void> {
        let message: { id?: unknown; method?: unknown; params?: unknown };
        try { message = JSON.parse(text) as typeof message; } catch { return; }
        if (typeof message.id !== 'number' || typeof message.method !== 'string') return;
        const answer = await this.#bridge.handle({ packageId, preview: false }, message.method, message.params);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, ...answer }));
    }
}
