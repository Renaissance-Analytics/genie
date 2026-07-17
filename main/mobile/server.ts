import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { detectTailnetIp, isCgnatIp } from './tailnet';
import {
    resolveNetworkListeners,
    type RemoteNetworkAccess,
} from './network-access';
import { ensureCert, buildMobileUrl, shouldRenew, type MobileCert } from './tls';
import { handleApi, terminalServable, type MobileDataDeps } from './api';
import {
    handleSiteProxy,
    handleSiteProxyUpgrade,
    SITE_PROXY_PREFIX,
    type SiteProxyDeps,
} from './site-proxy';
import { setEventSockets, mobileEmit } from './bus';
import {
    attachTerminalSocket,
    mobileTermFanout,
    mobileTermClose,
    nextPtyGrid,
    setTerminalRepaintHandler,
} from './terminal-bridge';
import { initAuth, validateSession, type ConfirmPairHook } from './auth';
import { initAudit, setLocked, isLocked, audit } from './audit';
import { onQuestionsChanged } from '../ask/force-question';
import { hostInstallId } from '../host-identity';

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
    /** Bind the host server when EITHER surface is on (phone UI or desktop remote). */
    enabled: boolean;
    /**
     * Serve the phone web UI (`/m`). When false but `enabled` (desktop-remote-only),
     * the API/WS still bind for Genie Remote but the phone UI is 404'd. Defaults to
     * `enabled` when unset (back-compat for callers that only pass `enabled`).
     */
    mobileUiEnabled?: boolean;
    /**
     * Allow desktop Genie Remote connections (Settings → Genie Remote). Independent
     * of the phone UI — either surface can be on alone; the server binds if either
     * is on. Recorded so the toggle setters can recompute the bind gate.
     */
    remoteEnabled?: boolean;
    /** The user-configured fixed port (Settings → Mobile). */
    configuredPort: () => number;
    /** Explicit network exposure policy. Omitted preserves the legacy
     * Tailscale-only listener for compatibility. */
    networkAccess?: RemoteNetworkAccess;
    /** Reused terminal/process/workspace/question functions (built in background.ts). */
    data: MobileDataDeps;
    /**
     * Serve-local-sites (Phase C) — the host reverse proxy's settings/allowlist
     * accessors (master switch + opaque-siteId → loopback-target resolver).
     * Optional: a host that predates the feature leaves it UNWIRED and the
     * `/api/site/*` proxy route + its WS upgrade are simply not served.
     */
    siteProxy?: SiteProxyDeps;
    /** Desktop one-time pairing confirm (reuses forceQuestion/dialog). */
    confirmPair: ConfirmPairHook;
    /**
     * TEST ONLY — bind to this IP instead of the resolved tailnet IP, bypassing
     * the fail-closed tailnet assert. Lets the integration test drive REST/WS on
     * 127.0.0.1 with no real tailnet. NEVER set in production.
     */
    bindIpOverride?: string;
}

const servers = new Map<string, http.Server | https.Server>();
const websocketServers = new Set<WebSocketServer>();
let boundIp: string | null = null;
let boundPort: number | null = null;
/** True when bound over HTTPS (a Tailscale cert was issued); false = http. */
let boundSecure = false;
/** The MagicDNS name HTTPS is addressed by (cert can't cover a raw 100.x IP). */
let boundDnsName: string | null = null;
/** The cert currently serving (for the renewal check); null over http. */
let activeCert: MobileCert | null = null;
/** Daily cert-renewal timer (rebinds when the cert nears expiry). */
let renewTimer: ReturnType<typeof setInterval> | null = null;
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

/**
 * The remote-facing origin the site-proxy is served on (for `Location`
 * rewrites): `https://<magic-dns>:<port>` over a Tailscale cert, else
 * `http://<ip>:<port>`. The scheme here is what a rewritten `Location` inherits,
 * so it also drives the http-fallback downgrade.
 */
export function proxyOriginForRequest(
    req: {
        headers: http.IncomingHttpHeaders;
        socket: {
            encrypted?: boolean;
            localAddress?: string;
            localPort?: number;
        };
    },
    tlsDnsName: string | null = null,
): string {
    const socket = req.socket;
    const secure = socket.encrypted === true;
    const host = secure && tlsDnsName
        ? tlsDnsName
        : socket.localAddress ?? '127.0.0.1';
    const port = socket.localPort ?? boundPort ?? 0;
    return `${secure ? 'https' : 'http'}://${host}:${port}`;
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

    // Serve-local-sites (Phase C): the host reverse proxy. MUST precede the
    // generic /api/ handler — its path `/api/site/<id>/…` is under /api/. Only
    // routed when wired (a host that predates the feature leaves siteProxy off,
    // and /api/site/* falls through to handleApi's 404). It runs its OWN gate
    // (token + kill-switch + both opt-ins + SSRF allowlist) and streams the
    // loopback upstream itself.
    if (deps.siteProxy && pathname.startsWith(SITE_PROXY_PREFIX)) {
        await handleSiteProxy(req, res, deps.siteProxy, {
            proxyOrigin: proxyOriginForRequest(req, boundDnsName),
        });
        return;
    }

    if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, deps.data, {
            ip: clientIp(req),
            ua: String(req.headers['user-agent'] ?? ''),
            serverVersion: deps.serverVersion,
            // Stable, carrier-independent host identity for the `/api/ping` beacon
            // (the discriminator between hosts + the migration-safe pairing key).
            hostId: hostInstallId(deps.userDataDir),
            // The MagicDNS name we're serving HTTPS under (null over http), carried
            // as a stable DIAL ADDRESS alongside the mutable IP — not identity.
            dnsName: boundDnsName,
        });
        return;
    }

    // Phone web UI (`/m`) is served ONLY when the mobile UI is enabled. When the
    // server is bound for desktop Genie Remote only (remote on, mobile off), the
    // API/WS above still work but the phone shell is 404'd — the "Mobile UI off"
    // toggle genuinely withholds the phone surface.
    const mobileUi = deps.mobileUiEnabled ?? deps.enabled;
    if (mobileUi && serveStatic(res, deps.appDir, pathname)) return;

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
        // Host must be our bound ip OR — over HTTPS — our MagicDNS name (the phone
        // loads https://<dnsname>:<port>/m/, so a same-origin wss upgrade carries
        // the dnsname as its Origin, not the raw ip). Any port is fine (same
        // machine); a rebinding attacker's page would carry its OWN origin.
        return (
            servers.has(u.hostname) ||
            u.hostname === boundIp ||
            (!!boundDnsName && u.hostname === boundDnsName)
        );
    } catch {
        return false;
    }
}

/** Wire the WS server onto the http upgrade event. Two endpoints, token-gated.
 *  Works on http OR https servers (both emit 'upgrade'; TLS terminates first). */
function attachWebSocket(srv: http.Server | https.Server): void {
    const socketServer = new WebSocketServer({ noServer: true });
    websocketServers.add(socketServer);
    setEventSockets(eventSockets);

    srv.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${boundIp ?? '127.0.0.1'}`);
        const pathname = url.pathname;

        // Serve-local-sites (Phase C): a site's WS upgrade (HMR / Vite / Reverb /
        // Echo) is proxied to loopback. It runs its OWN gate (origin +
        // Bearer/`?__genie_token=` + kill-switch + both opt-ins + allowlist),
        // accepting a Bearer that the shared `?token=` gate below can't, so it
        // must branch FIRST. Only when wired.
        if (deps?.siteProxy && pathname.startsWith(SITE_PROXY_PREFIX)) {
            void handleSiteProxyUpgrade(req, socket, head, deps.siteProxy, { originAllowed });
            return;
        }

        const token = url.searchParams.get('token');

        // DNS-rebinding + token gate BEFORE we accept the socket.
        if (!originAllowed(req) || !validateSession(token)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        if (pathname === '/ws/events') {
            const ip = req.socket.remoteAddress ?? 'unknown';
            socketServer.handleUpgrade(req, socket, head, (ws) => {
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
            // Headless (genie-cloud): never bridge a terminal outside a served
            // workspace — the System workspace (and any null-workspace pty) is
            // unreachable even by a known/guessed id. Fail-closed. Desktop: allow.
            if (!deps || !terminalServable(deps.data, terminalId)) {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }
            socketServer.handleUpgrade(req, socket, head, (ws) => {
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
function resolveBindIps(): string[] {
    if (deps?.bindIpOverride) return [deps.bindIpOverride];
    if (deps?.networkAccess) {
        return resolveNetworkListeners(deps.networkAccess)
            // LAN must not carry bearer sessions over plaintext HTTP. It remains
            // fail-closed until the host certificate/enrollment phase can give
            // direct LAN peers an authenticated TLS path.
            .filter((listener) => listener.network !== 'lan')
            .map((listener) => listener.ip);
    }
    const tailnet = detectTailnetIp();
    return tailnet ? [tailnet] : [];
}

/** Bind the server on `ip:port`, flagging a conflict on EADDRINUSE (no fallback).
 *  Prefers browser-trusted HTTPS via a Tailscale cert; FAILS OPEN to http-over-
 *  WireGuard (still encrypted) when the tailnet can't provide one. */
async function bind(ip: string, wantPort: number): Promise<void> {
    // Try a Tailscale cert for HTTPS. Skipped under the test bind-override (no real
    // tailnet — and we must never issue a real cert from the integration test).
    activeCert =
        deps && !deps.bindIpOverride && isCgnatIp(ip)
            ? await ensureCert(deps.userDataDir)
            : null;

    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
        void handle(req, res).catch(() => {
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'internal error' }));
            } catch {
                /* response already sent */
            }
        });
    };

    let srv: http.Server | https.Server;
    if (activeCert) {
        try {
            const cert = fs.readFileSync(activeCert.certFile);
            const key = fs.readFileSync(activeCert.keyFile);
            srv = https.createServer({ cert, key }, onRequest);
            boundSecure = true;
            boundDnsName = activeCert.dnsName;
        } catch {
            // Cert files vanished/unreadable → fall back to http.
            activeCert = null;
            boundSecure = false;
            boundDnsName = null;
            srv = http.createServer(onRequest);
        }
    } else {
        boundSecure = false;
        boundDnsName = null;
        srv = http.createServer(onRequest);
    }

    return new Promise((resolve) => {
        srv.once('error', (e: NodeJS.ErrnoException) => {
            if (e.code === 'EADDRINUSE') {
                // Port taken → flag conflict, DON'T fall back (the URL must stay
                // stable). The user is told and a restart on a freed port fixes it.
                conflict = true;
            }
            resolve(); // give up this run; status surfaces the conflict
        });
        srv.listen(wantPort, ip, () => {
            servers.set(ip, srv);
            const addr = srv.address();
            const listeningPort = typeof addr === 'object' && addr ? addr.port : wantPort;
            if (boundIp === null || isCgnatIp(ip)) {
                boundIp = ip;
                boundPort = listeningPort;
            }
            conflict = false;
            attachWebSocket(srv);
            persistState();
            scheduleCertRenewal();
            resolve();
        });
    });
}

/** Daily cert-renewal check: `tailscale cert` renews in place, so when the active
 *  cert nears expiry we rebind (which re-runs ensureCert). No-op over http. The
 *  timer is unref'd so it never keeps the process alive. */
function scheduleCertRenewal(): void {
    if (renewTimer) return;
    renewTimer = setInterval(() => void maybeRenewCert(), 24 * 60 * 60 * 1000);
    renewTimer.unref?.();
}

async function maybeRenewCert(): Promise<void> {
    if (servers.size === 0 || !activeCert) return;
    if (!shouldRenew(activeCert.notAfter)) return;
    await restartMobileServer();
}

/**
 * Start the mobile server (idempotent). FAIL CLOSED: if disabled, or no tailnet
 * is detected, the server does NOT bind — it just records the reason for the
 * status. Resolves once listening (or once we've given up). Non-fatal by design;
 * background.ts awaits then ignores failures.
 */
export async function startMobileServer(d: MobileServerDeps): Promise<void> {
    deps = d;
    // Repaint-on-drop: when the terminal bridge drops a frame to a client, it
    // asks the pty to re-emit a clean frame (SIGWINCH nudge) so a full-screen
    // TUI resyncs instead of staying scrambled. The pty lives behind the deps.
    setTerminalRepaintHandler((id) => deps?.data.repaint?.(id));
    initAudit(d.userDataDir);
    initAuth({ userDataDir: d.userDataDir, confirmPair: d.confirmPair });
    // Push new/resolved ForceTheQuestion prompts to /ws/events so a paired phone
    // sees them live (mobileEmit no-ops when nothing is connected). Subscribe once.
    if (!questionSubWired) {
        onQuestionsChanged(() => mobileEmit('question:changed'));
        questionSubWired = true;
    }
    if (servers.size > 0) return; // already running

    conflict = false;
    notDetected = false;

    if (!d.enabled) return; // opt-in — off by default

    const ips = resolveBindIps();
    if (ips.length === 0) {
        // No enabled/detected local listener → bind nothing.
        notDetected = d.networkAccess?.tailscale ?? true;
        return;
    }
    for (const ip of ips) await bind(ip, d.configuredPort());
    if (servers.size > 0) audit('server.start', `${ips.join(',')}:${boundPort}`, 'desktop');
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
    for (const socketServer of websocketServers) socketServer.close();
    websocketServers.clear();
    for (const srv of servers.values()) srv.close();
    servers.clear();
    boundIp = null;
    boundPort = null;
    boundSecure = false;
    boundDnsName = null;
    activeCert = null;
    if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
    }
    conflict = false;
}

/** Stop and re-bind on the currently-configured port (Settings → Restart). */
export async function restartMobileServer(): Promise<void> {
    if (!deps) return;
    stopMobileServer();
    // Re-read enabled/port via the live deps the caller passed at start.
    if (!deps.enabled) return;
    const ips = resolveBindIps();
    if (ips.length === 0) {
        notDetected = deps.networkAccess?.tailscale ?? true;
        return;
    }
    notDetected = false;
    for (const ip of ips) await bind(ip, deps.configuredPort());
    if (servers.size > 0) audit('server.restart', `${ips.join(',')}:${boundPort}`, 'desktop');
}

/** Update the phone-UI toggle (Settings → Mobile) + recompute the bind gate. The
 *  server binds whenever the phone UI OR desktop Genie Remote is on. */
export function setMobileEnabled(enabled: boolean): void {
    if (!deps) return;
    deps.mobileUiEnabled = enabled;
    deps.enabled = enabled || !!deps.remoteEnabled;
}

/** Update the desktop Genie Remote toggle (Settings → Genie Remote) + recompute the
 *  bind gate. Lets remote bind the host server independently of the phone UI, so a
 *  desktop can connect without the Mobile toggle on. */
export function setRemoteEnabled(enabled: boolean): void {
    if (!deps) return;
    deps.remoteEnabled = enabled;
    deps.enabled = enabled || !!(deps.mobileUiEnabled ?? deps.enabled);
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
    /** True when the server is bound (either the phone UI or desktop remote is on). */
    enabled: boolean;
    /** True when the phone web UI (`/m`) is being served. */
    mobileUiEnabled: boolean;
    /** True when desktop Genie Remote connections are allowed. */
    remoteEnabled: boolean;
    /** The bound Tailscale IP (null when not running). */
    ip: string | null;
    /** The bound port (null when not running). */
    port: number | null;
    /** The port the user configured. */
    configuredPort: number;
    /** The phone URL — `https://<magic-dns>:<port>/m/` over TLS, else
     *  `http://<ip>:<port>/m/`; null when not running. */
    url: string | null;
    /** True when served over browser-trusted HTTPS (a Tailscale cert was issued);
     *  false = http-over-WireGuard (still encrypted, the fail-open fallback). */
    secure: boolean;
    /** True when the configured port was taken (no silent fallback). */
    conflict: boolean;
    /** True when the server is enabled but no Tailscale interface was found. */
    tailnetNotDetected: boolean;
    /** True when the global kill-switch is engaged. */
    locked: boolean;
    /** Remotes currently connected (drives the host's "remote session" overlay). */
    peers: MobilePeer[];
    listeners: Array<{
        network: 'local' | 'lan' | 'tailscale';
        ip: string;
        port: number;
        secure: boolean;
    }>;
}

export function mobileServerState(): MobileServerState {
    const url = buildMobileUrl({
        secure: boundSecure,
        dnsName: boundDnsName,
        ip: boundIp,
        port: boundPort,
    });
    return {
        running: servers.size > 0,
        enabled: deps?.enabled ?? false,
        mobileUiEnabled: (deps?.mobileUiEnabled ?? deps?.enabled) ?? false,
        remoteEnabled: deps?.remoteEnabled ?? false,
        ip: boundIp,
        port: boundPort,
        configuredPort: deps?.configuredPort() ?? DEFAULT_MOBILE_PORT,
        url,
        secure: boundSecure,
        conflict,
        tailnetNotDetected: notDetected,
        locked: isLocked(),
        peers: activeMobilePeers(),
        listeners: [...servers.entries()].map(([ip, srv]) => {
            const address = srv.address();
            return {
                network: ip === '127.0.0.1'
                    ? 'local'
                    : isCgnatIp(ip)
                        ? 'tailscale'
                        : 'lan',
                ip,
                port: typeof address === 'object' && address ? address.port : boundPort ?? 0,
                secure: isCgnatIp(ip) && boundSecure,
            };
        }),
    };
}
