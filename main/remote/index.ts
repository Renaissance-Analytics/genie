import { app, BrowserWindow, safeStorage } from 'electron';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Work Mode — remote desktop (the local-main proxy).
 *
 * MULTI-CONNECTION + PER-WINDOW. A single local Genie can drive SEVERAL remote
 * hosts at once, each in its OWN native Floor window, while the local window
 * keeps full local functionality. To make that work the remote state is no
 * longer global:
 *
 *   - `connections: Map<connKey, RemoteConnection>` — one live connection per
 *     host (`ip:port`). Each owns its session token, its `/ws/events` bridge,
 *     and its per-terminal `/ws/term` map. N can be live at once.
 *   - `bindings: Map<webContents.id, connKey>` — which host (if any) a WINDOW is
 *     driving. A window with no binding is LOCAL. The `remote:*` IPC handlers
 *     resolve the connection by the CALLING window (`event.sender.id`), so each
 *     window talks to exactly its own host (or local).
 *
 * The session token NEVER reaches the renderer — every host call is proxied
 * here, so the renderer can't leak it.
 *
 * BACK-COMPAT (pre-multi-window): a window with no explicit binding falls back
 * to the sole connection when exactly one exists, and connection events fan out
 * to ALL windows when nothing is bound — so the legacy single-host global flow
 * keeps working until the renderer adopts per-window binding (Phase 3).
 */

export interface RemoteHost {
    ip: string;
    port: number;
    hostname: string;
}

/** A live connection to one host. Self-contained: token + events bridge + ptys. */
interface RemoteConnection {
    host: RemoteHost;
    /** `ip:port` — the registry key + token-store key. */
    connKey: string;
    token: string;
    eventsWs: WebSocket | null;
    eventsClosed: boolean;
    eventsRetry: NodeJS.Timeout | null;
    /** Host terminal id → its `/ws/term` socket (viewer-only; never kills host pty). */
    termWs: Map<string, WebSocket>;
}

/** connKey → live connection. */
const connections = new Map<string, RemoteConnection>();
/** webContents.id → connKey. Absent ⇒ the window is LOCAL. */
const bindings = new Map<number, string>();

function connKeyOf(host: RemoteHost): string {
    return `${host.ip}:${host.port}`;
}

// Persisted per-host session tokens — so a paired host RECONNECTS with one click
// (no PIN). Keyed by ip:port, encrypted at rest via safeStorage when available.
// The PIN is only ever needed the FIRST time you pair a host, or if the saved
// token is rejected (host re-paired / forgot the device).
function tokenStorePath(): string {
    return path.join(app.getPath('userData'), 'genie-remote-tokens.json');
}
function readTokenStore(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(tokenStorePath(), 'utf8')) as Record<string, string>;
    } catch {
        return {};
    }
}
function writeTokenStore(store: Record<string, string>): void {
    try {
        fs.writeFileSync(tokenStorePath(), JSON.stringify(store), 'utf8');
    } catch {
        /* best-effort persistence */
    }
}
function loadSavedToken(host: RemoteHost): string | null {
    const enc = readTokenStore()[connKeyOf(host)];
    if (!enc) return null;
    try {
        return safeStorage.isEncryptionAvailable()
            ? safeStorage.decryptString(Buffer.from(enc, 'base64'))
            : enc;
    } catch {
        return null;
    }
}
function saveSavedToken(host: RemoteHost, token: string): void {
    const store = readTokenStore();
    store[connKeyOf(host)] = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(token).toString('base64')
        : token;
    writeTokenStore(store);
}
function clearSavedToken(host: RemoteHost): void {
    const store = readTokenStore();
    delete store[connKeyOf(host)];
    writeTokenStore(store);
}

/** Is a saved token on file for this host? (Lets the UI default to a 1-click
 *  reconnect and only show the PIN field for a first-time pair.) */
export function hasSavedToken(host: RemoteHost): boolean {
    return !!readTokenStore()[connKeyOf(host)];
}

// --- window ↔ connection resolution ----------------------------------------

/**
 * The connection a CALLING window should use, or null when it's local.
 * Explicit binding wins; otherwise (legacy global flow, before the renderer
 * adopts per-window binding) fall back to the sole connection when exactly one
 * exists. Once windows bind explicitly (Phase 2/3), only bound host windows
 * resolve to a connection here and the local window resolves to null (local).
 */
function connForWebContents(wcId: number): RemoteConnection | null {
    const key = bindings.get(wcId);
    if (key) return connections.get(key) ?? null;
    if (connections.size === 1) return connections.values().next().value ?? null;
    return null;
}

/** Bind a window to a host connection (called by the host-window factory). */
export function bindWindowToConnection(wcId: number, connKey: string): void {
    bindings.set(wcId, connKey);
}

/** Drop a window's binding (called on window close). Does NOT tear the
 *  connection down — that's `disconnectRemote` / the last-window sweep. */
export function unbindWindow(wcId: number): void {
    bindings.delete(wcId);
}

/** Per-window status — deliberately omits the token. */
export function remoteStatusFor(wcId: number): { connected: boolean; host: RemoteHost | null } {
    const conn = connForWebContents(wcId);
    return { connected: !!conn, host: conn?.host ?? null };
}

/** Per-window binding for the renderer's boot-time routing decision. */
export function remoteBindingFor(wcId: number): { mode: 'local' | 'remote'; host: RemoteHost | null } {
    const conn = connForWebContents(wcId);
    return { mode: conn ? 'remote' : 'local', host: conn?.host ?? null };
}

/** Send a payload to the windows that should receive a connection's events:
 *  the windows bound to it — or, when nothing is bound (legacy flow), all of
 *  them. */
function emitToConn(conn: RemoteConnection, channel: string, payload: unknown): void {
    const boundIds = new Set<number>();
    for (const [wcId, key] of bindings) if (key === conn.connKey) boundIds.add(wcId);
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        if (boundIds.size === 0 || boundIds.has(w.webContents.id)) {
            w.webContents.send(channel, payload);
        }
    }
}

/** Push each window its OWN status (correct for both legacy + multi-window). */
function broadcastStatus(): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        w.webContents.send('remote:status', remoteStatusFor(w.webContents.id));
    }
}

// Host /ws/events types that map 1:1 onto the local IPC channels the desktop
// renderer ALREADY subscribes to — so re-emitting them makes the desktop's live
// dashboard updates (agent-attention glow, workspace pulse, process status,
// terminal-spec + workspace-list changes) work transparently in remote mode.
const PASSTHROUGH_EVENTS = new Set([
    'terminal:attention',
    'workspace:pulse',
    'process:status',
    'terminal-spec:changed',
    'workspaces:changed',
]);

/** Connect a connection's host /ws/events and re-emit onto the local channels
 *  (scoped to its bound windows); reconnect on a fixed backoff while live. */
function startEventsBridge(conn: RemoteConnection): void {
    conn.eventsClosed = false;
    const scheduleRetry = () => {
        if (conn.eventsClosed || conn.eventsRetry) return;
        conn.eventsRetry = setTimeout(() => {
            conn.eventsRetry = null;
            open();
        }, 2000);
    };
    const open = () => {
        if (conn.eventsClosed) return;
        const url = `ws://${conn.host.ip}:${conn.host.port}/ws/events?token=${encodeURIComponent(conn.token)}`;
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            scheduleRetry();
            return;
        }
        conn.eventsWs = ws;
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(String(raw)) as { type?: string; payload?: unknown };
                if (msg.type && PASSTHROUGH_EVENTS.has(msg.type)) emitToConn(conn, msg.type, msg.payload);
            } catch {
                /* ignore malformed frames */
            }
        });
        ws.on('close', () => {
            if (conn.eventsWs === ws) conn.eventsWs = null;
            if (!conn.eventsClosed) scheduleRetry();
        });
        ws.on('error', () => {
            try {
                ws.close();
            } catch {
                /* already closing */
            }
        });
    };
    open();
}

function stopEventsBridge(conn: RemoteConnection): void {
    conn.eventsClosed = true;
    if (conn.eventsRetry) {
        clearTimeout(conn.eventsRetry);
        conn.eventsRetry = null;
    }
    try {
        conn.eventsWs?.close();
    } catch {
        /* already closing */
    }
    conn.eventsWs = null;
}

// --- per-terminal pty bridge ----------------------------------------------
// The desktop terminal grid drives a host's pty-host terminals: the renderer's
// XTerm subscribes to terminal:data {id} as usual, and the main feeds it from the
// host's pty over a per-terminal /ws/term, forwarding the renderer's input/resize
// back. Keyed by terminal id, per connection; attach is idempotent. The pty itself
// lives on the HOST (its detached pty-host) and is never touched on detach.

/** Attach to a host terminal's pty stream and re-emit terminal:data/exit onto the
 *  calling window's channels (keyed by id). Idempotent per id. */
export function remoteAttachTerminal(wcId: number, id: string): void {
    const conn = connForWebContents(wcId);
    if (!conn || conn.termWs.has(id)) return;
    const url = `ws://${conn.host.ip}:${conn.host.port}/ws/term?terminal=${encodeURIComponent(id)}&token=${encodeURIComponent(conn.token)}`;
    let ws: WebSocket;
    try {
        ws = new WebSocket(url);
    } catch {
        return;
    }
    conn.termWs.set(id, ws);
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(String(raw)) as {
                type?: string;
                data?: string;
                exitCode?: number;
                signal?: number;
            };
            if (msg.type === 'data' && typeof msg.data === 'string') {
                emitToConn(conn, 'terminal:data', { id, data: msg.data });
            } else if (msg.type === 'exit') {
                emitToConn(conn, 'terminal:exit', { id, exitCode: msg.exitCode ?? 0, signal: msg.signal });
            }
            // 'dropped' (host backpressure marker) — ignored; on re-attach the
            // host replays scrollback, so the viewport catches up.
        } catch {
            /* ignore malformed frames */
        }
    });
    ws.on('close', () => {
        if (conn.termWs.get(id) === ws) conn.termWs.delete(id);
    });
    ws.on('error', () => {
        try {
            ws.close();
        } catch {
            /* already closing */
        }
    });
}

/** Forward the renderer's keystrokes to the host pty. */
export function remoteTerminalInput(wcId: number, id: string, data: string): void {
    const ws = connForWebContents(wcId)?.termWs.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: 'input', data }));
        } catch {
            /* socket died mid-send — the renderer re-attaches */
        }
    }
}

/** Forward a viewport resize to the host pty. */
export function remoteTerminalResize(wcId: number, id: string, cols: number, rows: number): void {
    const ws = connForWebContents(wcId)?.termWs.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        } catch {
            /* dropped — replayed on the next resize */
        }
    }
}

/** Detach the viewer from a host terminal (NEVER kills the host pty). */
export function remoteDetachTerminal(wcId: number, id: string): void {
    const ws = connForWebContents(wcId)?.termWs.get(id);
    if (ws) {
        try {
            ws.close();
        } catch {
            /* already closing */
        }
        connForWebContents(wcId)?.termWs.delete(id);
    }
}

function closeAllTerminals(conn: RemoteConnection): void {
    for (const ws of conn.termWs.values()) {
        try {
            ws.close();
        } catch {
            /* already closing */
        }
    }
    conn.termWs.clear();
}

/**
 * Pair with + connect to a host Genie, adding it to the registry. `POST /api/pair
 * {pin}` — the host pops a desktop confirm, so this BLOCKS until the user approves
 * on the host (or it's declined / times out). On success the connection is live in
 * the registry (`connKey`) with its events bridge running; the caller binds a
 * window to it. Reconnecting an already-live host is a no-op success.
 */
export async function connectRemote(
    host: RemoteHost,
    pin?: string,
): Promise<{ ok: boolean; connKey?: string; error?: string; needsPin?: boolean }> {
    const connKey = connKeyOf(host);

    // Already connected to this host → reuse it (a host window re-open / a second
    // request for the same host shares the one connection).
    const existing = connections.get(connKey);
    if (existing) return { ok: true, connKey };

    let token: string;

    if (pin) {
        // First pairing (or re-pair): PIN → token. Remember it so EVERY future
        // reconnect is one click, no PIN.
        let res: Response;
        try {
            res = await fetch(`http://${host.ip}:${host.port}/api/pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin }),
            });
        } catch (e) {
            return { ok: false, error: `Couldn't reach ${host.hostname}: ${(e as Error).message}` };
        }
        if (!res.ok) {
            const error =
                res.status === 401
                    ? 'Wrong PIN — check the host and try again.'
                    : res.status === 403
                        ? 'The host declined this device.'
                        : res.status === 429
                            ? 'Too many attempts — wait a moment and retry.'
                            : `Pairing failed (HTTP ${res.status}).`;
            return { ok: false, error };
        }
        const data = (await res.json().catch(() => null)) as { token?: string } | null;
        if (!data?.token) return { ok: false, error: 'Malformed pairing response from the host.' };
        token = data.token;
        saveSavedToken(host, token);
    } else {
        // Reconnect with the REMEMBERED token — no PIN. needsPin tells the UI to
        // reveal the PIN field only for a genuine first-time pair.
        const saved = loadSavedToken(host);
        if (!saved) return { ok: false, needsPin: true };
        token = saved;
    }

    // Validate before entering remote mode (a cheap authed call). A 401 means a
    // saved token is dead (host re-paired / forgot the device) → forget it + ask
    // for the PIN rather than failing opaquely.
    try {
        const res = await fetch(`http://${host.ip}:${host.port}/api/state`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
            clearSavedToken(host);
            return { ok: false, needsPin: true };
        }
        if (!res.ok && res.status !== 423) {
            return { ok: false, error: `Host returned HTTP ${res.status}.` };
        }
    } catch (e) {
        return { ok: false, error: `Couldn't reach ${host.hostname}: ${(e as Error).message}` };
    }

    const conn: RemoteConnection = {
        host,
        connKey,
        token,
        eventsWs: null,
        eventsClosed: false,
        eventsRetry: null,
        termWs: new Map(),
    };
    connections.set(connKey, conn);
    startEventsBridge(conn);
    broadcastStatus();
    return { ok: true, connKey };
}

/** Tear a single connection down (viewer-only — never touches host terminals). */
function teardownConnection(conn: RemoteConnection): void {
    stopEventsBridge(conn);
    closeAllTerminals(conn);
    connections.delete(conn.connKey);
    // Drop any window bindings that pointed at it.
    for (const [wcId, key] of [...bindings]) if (key === conn.connKey) bindings.delete(wcId);
}

/**
 * Leave remote mode. With a `wcId`, disconnect ONLY the connection that window is
 * driving (the others stay live). Without one (legacy global disconnect), tear
 * down every connection. Viewer-only — never touches the host's terminals.
 */
export function disconnectRemote(wcId?: number): void {
    if (typeof wcId === 'number') {
        const conn = connForWebContents(wcId);
        if (conn) teardownConnection(conn);
    } else {
        for (const conn of [...connections.values()]) teardownConnection(conn);
    }
    broadcastStatus();
}

/**
 * Proxy a REST call to the calling window's host (Bearer token attached). This is
 * the generic transport the renderer's remote bridge maps every desktop method
 * onto. A 401 means the token died host-side → we drop that connection so the
 * window's UI returns local.
 */
export async function remoteRequest(
    wcId: number,
    reqPath: string,
    init?: { method?: string; json?: unknown },
): Promise<unknown> {
    const conn = connForWebContents(wcId);
    if (!conn) throw new Error('Not connected to a host.');

    const headers: Record<string, string> = { Authorization: `Bearer ${conn.token}` };
    let body: string | undefined;
    if (init?.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.json);
    }

    const res = await fetch(`http://${conn.host.ip}:${conn.host.port}${reqPath}`, {
        method: init?.method ?? 'GET',
        headers,
        body,
    });

    if (res.status === 401) {
        teardownConnection(conn);
        broadcastStatus();
        throw new Error('Remote session expired — re-pair with the host.');
    }
    if (res.status === 423) {
        throw new Error('The host has remote control locked.');
    }
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const d = (await res.json()) as { error?: string };
            if (d?.error) msg = d.error;
        } catch {
            /* non-JSON error body */
        }
        throw new Error(msg);
    }
    if (res.status === 204) return undefined;
    return res.json().catch(() => undefined);
}
