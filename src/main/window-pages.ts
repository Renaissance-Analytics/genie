import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { format } from 'node:url';

/**
 * GENIE'S WINDOWS LOAD FROM http://genie.localhost:<port> (Tynn #683), NOT file://.
 *
 * Why: the passkey lock (#677) asks for a passkey in the window, and WebAuthn refuses every origin that is not https or
 * http on a `localhost` name. Measured in Genie's own Electron (queue item 1113-172626-919eb1): file://, a privileged
 * custom scheme with `secure: true` and http://127.0.0.1 were all refused; http://genie.localhost registered and asserted
 * a credential that a server-side verifier accepted. Chromium resolves every `*.localhost` name to loopback itself, so the
 * name needs no hosts file and no DNS.
 *
 * What it serves: the built renderer's five pages and its flat `assets/` files, by an ALLOW-LIST — never a walk of the
 * filesystem, never a listing. It listens on 127.0.0.1 only, answers only a request whose Host is its own
 * `genie.localhost:<port>` (anything else could be a page on another name that rebinds to 127.0.0.1), and only GET/HEAD.
 * Nothing secret is served: the files are the open-source build. The window's DATA still moves over the IPC door; HTTP
 * carries the page and nothing else.
 *
 * The port: one per userData folder (where the window's localStorage lives, keyed by origin, port included), kept in
 * `<userData>/window-origin.json` and used again on every start so the origin — and what the window remembered under it —
 * stays the same. A first start picks one at random in {@link WINDOW_PORT_RANGE} (below every OS's ephemeral range, so an
 * outgoing connection does not take it between runs). A port that is taken is tried again a few times (a Genie that is
 * just exiting), then Genie moves to another, says so in its log, and keeps the new one. Genie only ever loads a window
 * from a port THIS process bound, so a process squatting the old port never serves Genie's window.
 */

export const WINDOW_HOST = 'genie.localhost';
export const WINDOW_PAGES = ['index', 'doctor', 'question', 'host-wait', 'browser'] as const;
export type WindowPage = (typeof WINDOW_PAGES)[number];
/** [from, to): below Windows' dynamic range (49152+) and Linux's (32768+). */
export const WINDOW_PORT_RANGE: readonly [number, number] = [20000, 30000];
const BIND = '127.0.0.1';

/**
 * Sent with every page, beside each page's own meta policy (the browser applies both, so each page is as strict as its
 * meta says). The header adds what a meta cannot: `frame-ancestors`.
 */
export const WINDOW_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

export interface WindowFile {
    /** Relative to the built renderer directory, forward slashes. */
    readonly relative: string;
    readonly contentType: string;
    readonly cache: string;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
/** The build's output types, and only those. An unknown extension is not served, whatever the file is. */
const ASSET_TYPES: Readonly<Record<string, string>> = {
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    map: 'application/json; charset=utf-8',
    json: 'application/json; charset=utf-8',
    wasm: 'application/wasm',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
};
/** One path segment of safe characters: no slash of either kind, no percent-escape, no leading dot. */
const ASSET_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const PAGE_PATH = new Map<string, WindowPage>(WINDOW_PAGES.map((p) => [`/${p}.html`, p]));

/**
 * Which file a request path may mean: `/<page>.html` for the five pages, `/assets/<one safe segment>.<known type>`, and
 * nothing else. Traversal cannot be expressed: a name with a slash, a backslash, a `%` or a `..` fails the pattern before
 * any filesystem path is built.
 */
export function windowFile(urlPath: string): WindowFile | null {
    const path = urlPath.split(/[?#]/, 1)[0] ?? '';
    const page = PAGE_PATH.get(path);
    if (page) return { relative: `${page}.html`, contentType: 'text/html; charset=utf-8', cache: 'no-store' };
    const m = /^\/assets\/([^/]+)$/.exec(path);
    if (!m) return null;
    const name = m[1]!;
    if (!ASSET_NAME.test(name) || name.includes('..')) return null;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    const contentType = ASSET_TYPES[name.slice(dot + 1).toLowerCase()];
    return contentType ? { relative: `assets/${name}`, contentType, cache: IMMUTABLE } : null;
}

export interface PageLoad {
    readonly search?: string;
    readonly hash?: string;
}

/** The page's URL, with search and hash written exactly as Electron's `loadFile` writes them (Node's `url.format`). */
export function windowPageUrl(port: number, page: WindowPage, load: PageLoad = {}): string {
    return format({ protocol: 'http', slashes: true, host: `${WINDOW_HOST}:${port}`, pathname: `/${page}.html`, search: load.search, hash: load.hash });
}

export interface WindowServerOptions {
    /** The built renderer directory (`dist/renderer`). */
    readonly root: string;
    /** `<userData>/window-origin.json`: the port this userData's windows use. */
    readonly portFile: string;
    readonly log?: (line: string) => void;
    /** How long to wait between tries of a taken remembered port (a Genie that is just exiting). Tests pass 0. */
    readonly retryDelayMs?: number;
}

export interface WindowServer {
    readonly port: number;
    readonly address: string;
    url(page: WindowPage, load?: PageLoad): string;
    close(): Promise<void>;
}

function rememberedPort(portFile: string): number | null {
    try {
        const v: unknown = JSON.parse(readFileSync(portFile, 'utf8'));
        const port = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as { port?: unknown }).port : undefined;
        return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
    } catch {
        return null;
    }
}

function remember(portFile: string, port: number): void {
    mkdirSync(dirname(portFile), { recursive: true });
    writeFileSync(portFile, JSON.stringify({ port }));
}

const randomPort = (): number => WINDOW_PORT_RANGE[0] + Math.floor(Math.random() * (WINDOW_PORT_RANGE[1] - WINDOW_PORT_RANGE[0]));

function listenOn(server: Server, port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
            server.off('listening', onListening);
            if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
            else reject(error);
        };
        const onListening = () => { server.off('error', onError); resolve(true); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, BIND);
    });
}

function hostIsOurs(host: string | undefined, port: number): boolean {
    return typeof host === 'string' && host.toLowerCase() === `${WINDOW_HOST}:${port}`;
}

function answer(root: string, port: () => number) {
    return (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            if (!hostIsOurs(req.headers.host, port())) { res.statusCode = 403; res.end(); return; }
            if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); res.end(); return; }
            const file = windowFile(req.url ?? '');
            let body: Buffer | null = null;
            if (file) body = await readFile(join(root, file.relative)).catch(() => null);
            if (!file || !body) { res.statusCode = 404; res.end(); return; }
            res.statusCode = 200;
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Cache-Control', file.cache);
            if (file.relative.endsWith('.html')) {
                res.setHeader('Content-Security-Policy', WINDOW_CSP);
                res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            }
            res.setHeader('Content-Length', body.byteLength);
            if (req.method === 'HEAD') res.end(); else res.end(body);
        })().catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); });
    };
}

/** Starts the window server on this userData's port (see the file's note for how the port is chosen and kept). */
export async function startWindowServer(options: WindowServerOptions): Promise<WindowServer> {
    let bound = 0;
    const server = createServer(answer(options.root, () => bound));
    const delay = options.retryDelayMs ?? 500;
    const remembered = rememberedPort(options.portFile);
    let port: number | null = null;
    if (remembered !== null) {
        for (let attempt = 0; attempt < 4 && port === null; attempt++) {
            if (attempt > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
            if (await listenOn(server, remembered)) port = remembered;
        }
        if (port === null) options.log?.(`[window-pages] port ${remembered} (this Genie's window origin) is taken by something else; moving Genie's windows to another port`);
    }
    for (let attempt = 0; attempt < 40 && port === null; attempt++) {
        const candidate = randomPort();
        if (candidate !== remembered && (await listenOn(server, candidate))) port = candidate;
    }
    if (port === null) throw new Error(`no free port for Genie's windows in ${WINDOW_PORT_RANGE[0]}-${WINDOW_PORT_RANGE[1] - 1}`);
    bound = (server.address() as AddressInfo).port;
    if (bound !== remembered) remember(options.portFile, bound);
    options.log?.(`[window-pages] Genie's windows load from http://${WINDOW_HOST}:${bound}`);
    return {
        port: bound,
        address: (server.address() as AddressInfo).address,
        url: (page, load) => windowPageUrl(bound, page, load),
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
    };
}

let configured: WindowServerOptions | null = null;
let shared: Promise<WindowServer> | null = null;

/** Where this process's windows come from. Called once, before the process opens its first window. */
export function configureWindowPages(options: WindowServerOptions): void {
    configured = options;
}

/** Load one of Genie's pages into a window, from this process's window server (started on first use). */
export function loadWindowPage(contents: { loadURL(url: string): Promise<unknown> }, page: WindowPage, load?: PageLoad): Promise<void> {
    if (!configured) return Promise.reject(new Error('Genie\'s window pages are not configured in this process (configureWindowPages)'));
    const options = configured;
    shared ??= startWindowServer(options).catch((error: unknown) => { shared = null; throw error; });
    return shared.then((server) => contents.loadURL(server.url(page, load))).then(() => undefined);
}

/** Tests only: forget the configured server (it is closed by whoever started it). */
export async function resetWindowPagesForTests(): Promise<void> {
    const s = shared;
    configured = null;
    shared = null;
    if (s) await s.then((server) => server.close(), () => {});
}
