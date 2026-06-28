import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { detectTailnetIp } from './tailnet';
import { handleApi, type MobileDataDeps } from './api';
import { setEventSockets, mobileEmit } from './bus';
import {
    attachTerminalSocket,
    mobileTermFanout,
    mobileTermClose,
    nextPtyGrid,
} from './terminal-bridge';
import { initAuth, validateSession, type ConfirmPairHook } from './auth';
import { initAudit, setLocked, isLocked, audit } from './audit';
import { onQuestionsChanged } from '../ask/force-question';

/**
 * Genie's mobile remote-control server — a THIRD local server alongside the MCP
 * (main/mcp/server.ts) and control (main/control.ts) servers, but bound to the
 * Tailscale IPv4 instead of loopback so a paired phone can reach it over the
 * tailnet. It serves the Next static export of the mobile UI under `/m/`, gates
 * `/api/*` + the WS channels behind a session token, pushes live dashboard
 * events on `/ws/events`, and bridges pty bytes on `/ws/term`.
 *
 * SECURITY (baked in — the user's "free once paired + kill-switch" posture):
 *   - Binds ONLY to the resolved Tailscale IP. detectTailnetIp() is the single
 *     chokepoint; no tailnet ⇒ the server does NOT start (fail closed). We never
 *     bind 0.0.0.0 / 127.0.0.1 / a LAN address. A test-only `bindIpOverride`
 *     injects 127.0.0.1 so the integration test can drive it without a tailnet —
 *     it bypasses the assert deliberately and is never set in production.
 *   - EADDRINUSE → surface a `conflict` flag, never silently fall back to a
 *     random port (the phone URL must stay stable).
 *   - Static assets are unauthed (the app shell + chunks). `/api/pair` is the
 *     only unauthed data route. Every other request validates a Bearer/`?token`.
 *   - WS upgrades are Origin/Host-checked (DNS-rebinding) + token-bound.
 *
 * Modelled on mcp/server.ts: a single bound port (the `mobile_port` setting),
 * persisted-state file, readBody size guard, try/catch-500. `appDir = __dirname`
 * — the compiled `app/` dir holding background.js + the static export (so
 * `mobile.html` + `_next/*` sit beside it).
 */

/** The default fixed port — obscure, outside the OS ephemeral range. */
export const DEFAULT_MOBILE_PORT = 51718;

export interface MobileServerDeps {
    serverVersion: string;
    userDataDir: string;
    /** The compiled app dir holding mobile.html + _next/* (background.ts: __dirname). */
    appDir: string;
    /** Whether the user enabled the mobile server (Settings → Mobile). */
    enabled: boolean;
    /** The user-configured fixed port (Settings → Mobile). */
    configuredPort: () => number;
    /** Reused terminal/process/workspace/question functions (built in background.ts). */
    data: MobileDataDeps;
    /** Desktop one-time pairing confirm (reuses forceQuestion/dialog). */
    confirmPair: ConfirmPairHook;
    /**
     * TEST ONLY — bind to this IP instead of the resolved tailnet IP, bypassing
     * the fail-closed tailnet assert. Lets the integration test drive REST/WS on
     * 127.0.0.1 with no real tailnet. NEVER set in production.
     */
    bindIpOverride?: string;
}

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let boundIp: string | null = null;
let boundPort: number | null = null;
let conflict = false;
let notDetected = false;
let deps: MobileServerDeps | null = null;
/** One-time wiring of the ForceTheQuestion queue to the mobile push channel. */
let questionSubWired = false;

/** Live `/ws/events` dashboard sockets. The bus fans mobileEmit out to these. */
const eventSockets = new Set<WebSocket>();

/** A connected remote/phone session — surfaced to the HOST so it can SEE (and
 *  pause/end) who's controlling it, without having to kill the pairing. */
export interface MobilePeer {
    ip: string;
    since: number;
}
/** Per-events-socket peer info (ip + connect time) for the host presence overlay. */
const peerByEventSocket = new Map<WebSocket, MobilePeer>();
/** The remotes currently connected to `/ws/events` (drives host presence). */
export function activeMobilePeers(): MobilePeer[] {
    return [...peerByEventSocket.values()];
}

// --- static serving --------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

function contentType(file: string): string {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Inject `<base href="/m/">` into the served mobile.html `<head>` so the static
 * export's relative `./_next/...` asset URLs (assetPrefix:'./') resolve to
 * `/m/_next/...` regardless of the request's trailing slash — no build/config
 * change. Idempotent: skips if a <base> is already present.
 */
export function injectBaseHref(html: string): string {
    if (/<base\s/i.test(html)) return html;
    return html.replace(/<head([^>]*)>/i, '<head$1><base href="/m/">');
}

/**
 * Serve a static asset under `/m/`. Returns true if it handled the request.
 *   - `/m` or `/m/` → mobile.html (with the <base> injected).
 *   - `/m/_next/<rest>` and other `/m/<rest>` → file under appDir, with a
 *     path-traversal guard (the resolved path must stay inside appDir).
 */
export function serveStatic(
    res: http.ServerResponse,
    appDir: string,
    pathname: string,
): boolean {
    if (pathname !== '/m' && pathname !== '/m/' && !pathname.startsWith('/m/')) {
        return false;
    }

    // The app shell — `/m`, `/m/`, or any sub-path that isn't a real asset
    // (SPA-style) → mobile.html with the <base> injected.
    const rest = pathname === '/m' || pathname === '/m/' ? '' : pathname.slice('/m/'.length);

    const serveShell = (): boolean => {
        const shell = path.join(appDir, 'mobile.html');
        try {
            const html = injectBaseHref(fs.readFileSync(shell, 'utf8'));
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': Buffer.byteLength(html),
            });
            res.end(html);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('mobile UI not built');
        }
        return true;
    };

    if (rest === '') return serveShell();

    // Resolve the asset path and HARD-guard against traversal: the resolved
    // absolute path must remain inside appDir.
    const resolved = path.resolve(appDir, rest);
    const relative = path.relative(appDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return true;
    }

    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        try {
            const buf = fs.readFileSync(resolved);
            res.writeHead(200, {
                'Content-Type': contentType(resolved),
                'Content-Length': buf.length,
            });
            res.end(buf);
        } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('read error');
        }
        return true;
    }

    // A non-asset sub-path (deep link the SPA owns) → serve the shell so the
    // client router handles it.
    return serveShell();
}

// --- request handling ------------------------------------------------------

/** The client IP for audit + pairing — the socket's remote address. */
function clientIp(req: http.IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
}

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    if (!deps) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server not ready' }));
        return;
    }
    const url = new URL(req.url ?? '/', `http://${boundIp ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    // Bare `/` → redirect to the app shell so a typed host:port lands on the UI.
    if (pathname === '/') {
        res.writeHead(302, { Location: '/m/' });
        res.end();
        return;
    }

    if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, deps.data, {
            ip: clientIp(req),
            ua: String(req.headers['user-agent'] ?? ''),
        });
        return;
    }

    if (serveStatic(res, deps.appDir, pathname)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
}

// --- WS upgrade ------------------------------------------------------------

/**
 * Validate a WS upgrade's Origin/Host against the bound address (DNS-rebinding
 * guard). The phone loads the app from `http://<ip>:<port>/m/`, so a same-origin
 * WS connection carries that Origin (or none, for a non-browser client). We
 * REJECT an Origin whose host isn't our bound `ip:port` or the bound ip.
 */
function originAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers['origin'];
    if (!origin) return true; // non-browser client (no Origin) — token still gates it
    try {
        const u = new URL(origin);
        // Host must be our bound ip (any port is fine — same machine) — a
        // rebinding attacker's page would carry its OWN origin, not ours.
        return u.hostname === boundIp;
    } catch {
        return false;
    }
}

/** Wire the WS server onto the http upgrade event. Two endpoints, token-gated. */
function attachWebSocket(srv: http.Server): void {
    wss = new WebSocketServer({ noServer: true });
    setEventSockets(eventSockets);

    srv.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${boundIp ?? '127.0.0.1'}`);
        const pathname = url.pathname;
        const token = url.searchParams.get('token');

        // DNS-rebinding + token gate BEFORE we accept the socket.
        if (!originAllowed(req) || !validateSession(token)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        if (pathname === '/ws/events') {
            const ip = req.socket.remoteAddress ?? 'unknown';
            wss!.handleUpgrade(req, socket, head, (ws) => {
                eventSockets.add(ws);
                peerByEventSocket.set(ws, { ip, since: Date.now() });
                const drop = () => {
                    eventSockets.delete(ws);
                    peerByEventSocket.delete(ws);
                };
                ws.on('close', drop);
                ws.on('error', drop);
            });
            return;
        }

        if (pathname === '/ws/term') {
            const terminalId = url.searchParams.get('terminal');
            if (!terminalId) {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                socket.destroy();
                return;
            }
            wss!.handleUpgrade(req, socket, head, (ws) => {
                attachTerminalSocketAndDrive(ws, terminalId, token!);
            });
            return;
        }

        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
    });
}

/**
 * Drive one `/ws/term` socket: send catch-up scrollback, attach to the byte
 * stream, and handle the phone's input/resize messages. VIEWER-ONLY — detaching
 * never kills the pty.
 *
 * Up-messages (phone → server), JSON:
 *   { type:'input', data }            raw xterm bytes → writeToTerminal
 *   { type:'key', key, submit, text } logical key/submit (resolved client-side
 *                                     into bytes the phone sends as 'input')
 *   { type:'resize', cols, rows }     → resize
 */
function attachTerminalSocketAndDrive(
    ws: WebSocket,
    terminalId: string,
    token: string,
): void {
    if (!deps) {
        ws.close();
        return;
    }
    const detach = attachTerminalSocket(terminalId, ws);
    const actor = token.slice(0, 8);

    // Catch-up: send the current scrollback so the phone paints history at once.
    try {
        const scrollback = deps.data.getScrollback(terminalId);
        if (scrollback && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'data', data: scrollback }));
        }
    } catch {
        /* no scrollback — fine */
    }

    ws.on('message', (raw) => {
        let msg: { type?: string; data?: string; cols?: number; rows?: number };
        try {
            msg = JSON.parse(String(raw));
        } catch {
            return;
        }
        if (!deps) return;
        // Terminal writes honour the global kill-switch (free once paired, but a
        // locked desktop freezes everything).
        if (msg.type === 'input' && typeof msg.data === 'string') {
            if (isLocked()) return;
            deps.data.writeToTerminal(terminalId, msg.data);
            audit('terminal.write', `${terminalId} (${msg.data.length}b)`, actor);
        } else if (msg.type === 'resize') {
            // The pty is SHARED with the desktop window. A phone in a narrow
            // viewport must NOT shrink it (that reflows the desktop terminal
            // down). nextPtyGrid enforces grow-only: it returns the size to
            // apply ONLY when the phone would enlarge the pty, else null and we
            // leave the shared pty alone (the phone scrolls horizontally).
            const grid = nextPtyGrid(terminalId, Number(msg.cols), Number(msg.rows));
            if (grid) deps.data.resize(terminalId, grid.cols, grid.rows);
        }
    });

    ws.on('close', detach);
    ws.on('error', detach);
}

// --- lifecycle -------------------------------------------------------------

/** Persisted runtime state — currently just the last bound port for diagnostics. */
function persistState(): void {
    if (!deps?.userDataDir || boundPort === null) return;
    try {
        fs.writeFileSync(
            path.join(deps.userDataDir, 'genie-mobile-server.json'),
            JSON.stringify({ port: boundPort, ip: boundIp }) + '\n',
            { mode: 0o600 },
        );
    } catch {
        /* best-effort */
    }
}

/**
 * Resolve the bind IP: the test override (127.0.0.1, no tailnet needed) or the
 * detected Tailscale IP. Returns null when no tailnet is present (fail closed).
 */
function resolveBindIp(): string | null {
    if (deps?.bindIpOverride) return deps.bindIpOverride;
    return detectTailnetIp();
}

/** Bind the server on `ip:port`, flagging a conflict on EADDRINUSE (no fallback). */
function bind(ip: string, wantPort: number): Promise<void> {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            void handle(req, res).catch(() => {
                try {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'internal error' }));
                } catch {
                    /* response already sent */
                }
            });
        });
        srv.once('error', (e: NodeJS.ErrnoException) => {
            if (e.code === 'EADDRINUSE') {
                // Port taken → flag conflict, DON'T fall back (the URL must stay
                // stable). The user is told and a restart on a freed port fixes it.
                conflict = true;
            }
            resolve(); // give up this run; status surfaces the conflict
        });
        srv.listen(wantPort, ip, () => {
            server = srv;
            boundIp = ip;
            const addr = srv.address();
            boundPort = typeof addr === 'object' && addr ? addr.port : wantPort;
            conflict = false;
            attachWebSocket(srv);
            persistState();
            resolve();
        });
    });
}

/**
 * Start the mobile server (idempotent). FAIL CLOSED: if disabled, or no tailnet
 * is detected, the server does NOT bind — it just records the reason for the
 * status. Resolves once listening (or once we've given up). Non-fatal by design;
 * background.ts awaits then ignores failures.
 */
export async function startMobileServer(d: MobileServerDeps): Promise<void> {
    deps = d;
    initAudit(d.userDataDir);
    initAuth({ userDataDir: d.userDataDir, confirmPair: d.confirmPair });
    // Push new/resolved ForceTheQuestion prompts to /ws/events so a paired phone
    // sees them live (mobileEmit no-ops when nothing is connected). Subscribe once.
    if (!questionSubWired) {
        onQuestionsChanged(() => mobileEmit('question:changed'));
        questionSubWired = true;
    }
    if (server) return; // already running

    conflict = false;
    notDetected = false;

    if (!d.enabled) return; // opt-in — off by default

    const ip = resolveBindIp();
    if (!ip) {
        // No tailnet → bind nothing. The phone URL is unreachable, but Genie is
        // not exposed off-box. Surfaced as `notDetected` in the status.
        notDetected = true;
        return;
    }
    await bind(ip, d.configuredPort());
    if (server) audit('server.start', `${ip}:${boundPort}`, 'desktop');
}

/** Stop the server + drop every socket. */
export function stopMobileServer(): void {
    for (const ws of eventSockets) {
        try {
            ws.close();
        } catch {
            /* ignore */
        }
    }
    eventSockets.clear();
    setEventSockets(null);
    wss?.close();
    wss = null;
    server?.close();
    server = null;
    boundIp = null;
    boundPort = null;
    conflict = false;
}

/** Stop and re-bind on the currently-configured port (Settings → Restart). */
export async function restartMobileServer(): Promise<void> {
    if (!deps) return;
    stopMobileServer();
    // Re-read enabled/port via the live deps the caller passed at start.
    if (!deps.enabled) return;
    const ip = resolveBindIp();
    if (!ip) {
        notDetected = true;
        return;
    }
    notDetected = false;
    await bind(ip, deps.configuredPort());
    if (server) audit('server.restart', `${ip}:${boundPort}`, 'desktop');
}

/** Update the cached enabled flag (Settings toggle) before a restart. */
export function setMobileEnabled(enabled: boolean): void {
    if (deps) deps.enabled = enabled;
}

// Re-export the kill-switch + revoke so the desktop IPC layer drives them
// through one module (server.ts) without reaching into auth/audit directly.
export { setLocked, isLocked } from './audit';
export {
    regeneratePin,
    currentPin,
    revokeAllSessions,
    revokeSession,
    listSessions,
} from './auth';
// Re-export the terminal fanout so ipc.ts taps it with a single import.
export { mobileTermFanout, mobileTermClose } from './terminal-bridge';
export { mobileEmit } from './bus';

/** Status for Settings → Mobile (drives the URL / PIN / QR / conflict banner). */
export interface MobileServerState {
    running: boolean;
    enabled: boolean;
    /** The bound Tailscale IP (null when not running). */
    ip: string | null;
    /** The bound port (null when not running). */
    port: number | null;
    /** The port the user configured. */
    configuredPort: number;
    /** The phone URL `http://<ip>:<port>/m/`, or null when not running. */
    url: string | null;
    /** True when the configured port was taken (no silent fallback). */
    conflict: boolean;
    /** True when the server is enabled but no Tailscale interface was found. */
    tailnetNotDetected: boolean;
    /** True when the global kill-switch is engaged. */
    locked: boolean;
    /** Remotes currently connected (drives the host's "remote session" overlay). */
    peers: MobilePeer[];
}

export function mobileServerState(): MobileServerState {
    const url = boundIp && boundPort ? `http://${boundIp}:${boundPort}/m/` : null;
    return {
        running: server !== null,
        enabled: deps?.enabled ?? false,
        ip: boundIp,
        port: boundPort,
        configuredPort: deps?.configuredPort() ?? DEFAULT_MOBILE_PORT,
        url,
        conflict,
        tailnetNotDetected: notDetected,
        locked: isLocked(),
        peers: activeMobilePeers(),
    };
}
