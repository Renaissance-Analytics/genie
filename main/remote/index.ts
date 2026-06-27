import { BrowserWindow } from 'electron';
import { WebSocket } from 'ws';

/**
 * Work Mode — remote desktop (the local-main proxy).
 *
 * When this Genie is driving a HOST Genie in remote mode, the renderer keeps
 * calling `api()` and listening on the same IPC channels as always — but the
 * LOCAL MAIN reroutes those to the host over the tailnet. This module owns:
 *   - the active remote connection (host + session token) + status broadcast,
 *   - pairing (POST /api/pair — the host shows a desktop confirm, so it blocks
 *     until the user approves ON THE HOST),
 *   - `remoteRequest()` — the generic REST proxy the renderer bridge calls.
 *
 * The host-WS re-emit (/ws/events + per-terminal /ws/term → local IPC channels)
 * and terminal I/O forwarding land in the next increment; this is the connection
 * + REST foundation. The session token NEVER reaches the renderer — every host
 * call is proxied here, so the renderer can't leak it.
 */

export interface RemoteHost {
    ip: string;
    port: number;
    hostname: string;
}

interface RemoteState {
    host: RemoteHost | null;
    token: string | null;
    connected: boolean;
}

const state: RemoteState = { host: null, token: null, connected: false };

/** The host's base URL while connected, else null. */
export function remoteBase(): string | null {
    return state.host ? `http://${state.host.ip}:${state.host.port}` : null;
}

/** The active session token (main-only — never exposed to the renderer). */
export function remoteToken(): string | null {
    return state.token;
}

export function isRemote(): boolean {
    return state.connected;
}

/** Renderer-facing status — deliberately omits the token. */
export function remoteStatus(): { connected: boolean; host: RemoteHost | null } {
    return { connected: state.connected, host: state.host };
}

function broadcastStatus(): void {
    broadcast('remote:status', remoteStatus());
}

/** Send a payload onto a local IPC channel in every window. */
function broadcast(channel: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload);
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

let eventsWs: WebSocket | null = null;
let eventsClosed = false;
let eventsRetry: NodeJS.Timeout | null = null;

/** Connect the host's /ws/events and re-emit onto the local channels; reconnect
 *  on a fixed backoff while remote mode is active. */
function startEventsBridge(): void {
    eventsClosed = false;
    const scheduleRetry = () => {
        if (eventsClosed || eventsRetry) return;
        eventsRetry = setTimeout(() => {
            eventsRetry = null;
            open();
        }, 2000);
    };
    const open = () => {
        if (eventsClosed || !state.host || !state.token) return;
        const url = `ws://${state.host.ip}:${state.host.port}/ws/events?token=${encodeURIComponent(state.token)}`;
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            scheduleRetry();
            return;
        }
        eventsWs = ws;
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(String(raw)) as { type?: string; payload?: unknown };
                if (msg.type && PASSTHROUGH_EVENTS.has(msg.type)) broadcast(msg.type, msg.payload);
            } catch {
                /* ignore malformed frames */
            }
        });
        ws.on('close', () => {
            eventsWs = null;
            if (!eventsClosed) scheduleRetry();
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

function stopEventsBridge(): void {
    eventsClosed = true;
    if (eventsRetry) {
        clearTimeout(eventsRetry);
        eventsRetry = null;
    }
    try {
        eventsWs?.close();
    } catch {
        /* already closing */
    }
    eventsWs = null;
}

// --- per-terminal pty bridge ----------------------------------------------
// The desktop terminal grid drives the host's pty-host terminals: the renderer's
// XTerm subscribes to terminal:data {id} as usual, and the main feeds it from the
// host's pty over a per-terminal /ws/term, forwarding the renderer's input/resize
// back. Keyed by terminal id; attach is idempotent. The pty itself lives on the
// HOST (its detached pty-host) and is never touched on detach (viewer semantics).
const termWs = new Map<string, WebSocket>();

/** Attach to a host terminal's pty stream and re-emit terminal:data/exit onto the
 *  local channels (keyed by id). Idempotent per id; a no-op when not connected. */
export function remoteAttachTerminal(id: string): void {
    if (!state.host || !state.token || termWs.has(id)) return;
    const url = `ws://${state.host.ip}:${state.host.port}/ws/term?terminal=${encodeURIComponent(id)}&token=${encodeURIComponent(state.token)}`;
    let ws: WebSocket;
    try {
        ws = new WebSocket(url);
    } catch {
        return;
    }
    termWs.set(id, ws);
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(String(raw)) as {
                type?: string;
                data?: string;
                exitCode?: number;
                signal?: number;
            };
            if (msg.type === 'data' && typeof msg.data === 'string') {
                broadcast('terminal:data', { id, data: msg.data });
            } else if (msg.type === 'exit') {
                broadcast('terminal:exit', { id, exitCode: msg.exitCode ?? 0, signal: msg.signal });
            }
            // 'dropped' (host backpressure marker) — ignored; on re-attach the
            // host replays scrollback, so the viewport catches up.
        } catch {
            /* ignore malformed frames */
        }
    });
    ws.on('close', () => {
        if (termWs.get(id) === ws) termWs.delete(id);
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
export function remoteTerminalInput(id: string, data: string): void {
    const ws = termWs.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: 'input', data }));
        } catch {
            /* socket died mid-send — the renderer re-attaches */
        }
    }
}

/** Forward a viewport resize to the host pty. */
export function remoteTerminalResize(id: string, cols: number, rows: number): void {
    const ws = termWs.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        } catch {
            /* dropped — replayed on the next resize */
        }
    }
}

/** Detach the viewer from a host terminal (NEVER kills the host pty). */
export function remoteDetachTerminal(id: string): void {
    const ws = termWs.get(id);
    if (ws) {
        try {
            ws.close();
        } catch {
            /* already closing */
        }
        termWs.delete(id);
    }
}

function closeAllTerminals(): void {
    for (const ws of termWs.values()) {
        try {
            ws.close();
        } catch {
            /* already closing */
        }
    }
    termWs.clear();
}

/**
 * Pair with + connect to a host Genie. `POST /api/pair {pin}` — the host pops a
 * desktop confirm, so this BLOCKS until the user approves on the host (or it's
 * declined / times out). On success we hold the token + enter remote mode.
 */
export async function connectRemote(
    host: RemoteHost,
    pin: string,
): Promise<{ ok: boolean; error?: string }> {
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

    state.host = host;
    state.token = data.token;
    state.connected = true;
    broadcastStatus();
    startEventsBridge();
    return { ok: true };
}

/** Leave remote mode (viewer-only — never touches the host's terminals/processes). */
export function disconnectRemote(): void {
    stopEventsBridge();
    closeAllTerminals();
    state.host = null;
    state.token = null;
    state.connected = false;
    broadcastStatus();
}

/**
 * Proxy a REST call to the host (Bearer token attached). This is the generic
 * transport the renderer's remote bridge maps every desktop method onto. A 401
 * means the token died host-side → we drop remote mode so the UI returns local.
 */
export async function remoteRequest(
    path: string,
    init?: { method?: string; json?: unknown },
): Promise<unknown> {
    const base = remoteBase();
    if (!base || !state.token) throw new Error('Not connected to a host.');

    const headers: Record<string, string> = { Authorization: `Bearer ${state.token}` };
    let body: string | undefined;
    if (init?.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.json);
    }

    const res = await fetch(`${base}${path}`, {
        method: init?.method ?? 'GET',
        headers,
        body,
    });

    if (res.status === 401) {
        disconnectRemote();
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
