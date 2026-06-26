/**
 * Mobile remote-control client — the phone's ONLY channel to Genie.
 *
 * The mobile page runs in a plain browser over the wire (Tailscale), so there
 * is NO Electron preload bridge: `window.genie` / `api()` do not exist here.
 * Every byte of data flows through this module's `fetch` (REST) + `WebSocket`
 * clients against the page's own origin. We import ONLY the TYPE shapes from
 * `./genie` — never its `api()` runtime, which would throw in this context.
 *
 * Auth: a session token (minted by the desktop on pairing) lives in
 * localStorage and rides every REST call as `Authorization: Bearer <token>`
 * and every WS upgrade as `?token=<token>`. A 401 anywhere means the token is
 * dead — we clear it and fire the `needs-pair` signal so the shell drops back
 * to the Pair screen. A 423 means the desktop kill-switch ("Lock") is engaged;
 * we surface that as a typed error the UI shows as a non-blocking notice.
 */

import type {
    ForceAnswerSpec,
    ForceQuestionSpec,
    ProcessListItem,
} from './genie';

const TOKEN_KEY = 'genie.mobile.token';

// ---- shared shapes (mirror the server's REST payloads) --------------------

/** A workspace as the phone sees it (subset of the desktop WorkspaceRow). */
export interface MobileWorkspace {
    id: string;
    name: string;
    path: string;
}

/** A terminal as the phone sees it (subset of the desktop TerminalSpec). */
export interface MobileTerminal {
    id: string;
    workspaceId: string | null;
    label: string;
    cwd: string;
    running: boolean;
}

/**
 * One pending ForceTheQuestion request, as surfaced to the phone. `index 0`
 * is the request currently shown on the desktop modal; the questions render
 * exactly like `pages/ask.tsx`.
 */
export interface PendingQuestion {
    id: string;
    questions: ForceQuestionSpec[];
    workspaceLabel?: string;
    index: number;
}

/** The bootstrap snapshot returned by `GET /api/state`. */
export interface MobileState {
    workspaces: MobileWorkspace[];
    terminals: MobileTerminal[];
    processes: ProcessListItem[];
    questions: PendingQuestion[];
}

/** A `/ws/events` dashboard push. `payload` shape depends on `type`. */
export interface MobileEvent {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any;
}

/** A `/ws/term` down-message bridged from the pty. */
export type TermDownMessage =
    | { type: 'data'; data: string }
    | { type: 'dropped' }
    | { type: 'exit'; exitCode?: number; signal?: number };

export type ProcessAction = 'start' | 'stop' | 'restart';

// ---- errors ---------------------------------------------------------------

/**
 * A non-2xx REST response, carrying the HTTP status so callers can branch.
 * `status === 423` ⇒ desktop kill-switch is on; `status === 401` ⇒ token dead
 * (the client also clears the token + fires `needs-pair` before throwing).
 */
export class MobileApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
        this.name = 'MobileApiError';
    }

    /** Desktop "Lock" kill-switch is engaged — show a non-blocking notice. */
    get isLocked(): boolean {
        return this.status === 423;
    }

    /** Token invalid — the shell should return to the Pair screen. */
    get isUnauthorized(): boolean {
        return this.status === 401;
    }
}

// ---- token storage --------------------------------------------------------

export function getToken(): string | null {
    try {
        return window.localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
}

function setToken(token: string): void {
    try {
        window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
        /* private mode — token lives only for this page's lifetime then */
    }
}

export function clearToken(): void {
    try {
        window.localStorage.removeItem(TOKEN_KEY);
    } catch {
        /* nothing to clear */
    }
}

// ---- needs-pair signal ----------------------------------------------------

// A 401 from any authed route means the session is gone; the shell subscribes
// here to drop back to Pair. We keep a tiny listener set rather than reaching
// for a framework so the client stays UI-agnostic.
type NeedsPairListener = () => void;
const needsPairListeners = new Set<NeedsPairListener>();

/** Subscribe to "token rejected — re-pair". Returns an unsubscribe fn. */
export function onNeedsPair(cb: NeedsPairListener): () => void {
    needsPairListeners.add(cb);
    return () => needsPairListeners.delete(cb);
}

function fireNeedsPair(): void {
    clearToken();
    for (const cb of needsPairListeners) {
        try {
            cb();
        } catch {
            /* a bad listener must not stop the rest */
        }
    }
}

// ---- REST -----------------------------------------------------------------

/** The page's own origin — the server that served this HTML is the API host. */
function base(): string {
    return window.location.origin;
}

function authHeaders(): Record<string, string> {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Core fetch wrapper: attaches the bearer token, parses JSON, and maps non-2xx
 * to a `MobileApiError`. A 401 additionally clears the token + fires
 * `needs-pair` (so EVERY authed call funnels re-pair through one place).
 */
async function request<T>(
    path: string,
    init?: RequestInit & { json?: unknown },
): Promise<T> {
    const headers: Record<string, string> = {
        ...authHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
    };
    let body = init?.body;
    if (init?.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.json);
    }

    let res: Response;
    try {
        res = await fetch(`${base()}${path}`, { ...init, headers, body });
    } catch (e) {
        // Network/transport failure (server down, tailnet dropped). Surface a
        // 0-status error so the UI can show "can't reach Genie" distinct from
        // an auth/lock failure.
        throw new MobileApiError(
            0,
            e instanceof Error ? e.message : 'network error',
        );
    }

    if (res.status === 401) {
        fireNeedsPair();
        throw new MobileApiError(401, 'session expired');
    }

    if (!res.ok) {
        // Try to lift a `{error}` message off the body; fall back to status.
        let msg = `HTTP ${res.status}`;
        try {
            const data = await res.json();
            if (data && typeof data.error === 'string') msg = data.error;
        } catch {
            /* non-JSON error body — keep the status message */
        }
        throw new MobileApiError(res.status, msg);
    }

    // 204 / empty bodies → undefined; callers that expect data won't ask for it.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
}

// ---- pairing --------------------------------------------------------------

export type PairResult =
    | { ok: true }
    | { ok: false; reason: 'wrong-pin' | 'rate-limited' | 'denied' | 'error'; message: string };

/**
 * Exchange a PIN for a session token. The desktop shows a confirm modal, so
 * this request BLOCKS until the user confirms (or it times out) — the caller
 * shows a "Waiting for desktop confirmation…" state for the duration. On
 * success the token is persisted and subsequent calls are authed.
 *
 * Maps the documented status codes to a discriminated result so the UI can
 * show a precise message:
 *   200 → ok            401 → wrong PIN
 *   429 → rate-limited  403 → desktop denied the pairing
 */
export async function pair(pin: string): Promise<PairResult> {
    let res: Response;
    try {
        res = await fetch(`${base()}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
        });
    } catch (e) {
        return {
            ok: false,
            reason: 'error',
            message: e instanceof Error ? e.message : "Couldn't reach Genie",
        };
    }

    if (res.ok) {
        try {
            const data = (await res.json()) as { token?: string };
            if (data?.token) {
                setToken(data.token);
                return { ok: true };
            }
        } catch {
            /* fall through to error */
        }
        return { ok: false, reason: 'error', message: 'Malformed pairing response' };
    }

    if (res.status === 401)
        return { ok: false, reason: 'wrong-pin', message: 'Wrong PIN — check the desktop and try again.' };
    if (res.status === 429)
        return { ok: false, reason: 'rate-limited', message: 'Too many attempts. Wait a moment and try again.' };
    if (res.status === 403)
        return { ok: false, reason: 'denied', message: 'The desktop declined this device.' };
    return { ok: false, reason: 'error', message: `Pairing failed (HTTP ${res.status})` };
}

// ---- REST reads -----------------------------------------------------------

export function getState(): Promise<MobileState> {
    return request<MobileState>('/api/state');
}

export function listWorkspaces(): Promise<MobileWorkspace[]> {
    return request<{ workspaces: MobileWorkspace[] }>('/api/workspaces').then(
        (r) => r.workspaces,
    );
}

export function listProcesses(): Promise<ProcessListItem[]> {
    return request<{ processes: ProcessListItem[] }>('/api/processes').then(
        (r) => r.processes,
    );
}

export function listTerminals(): Promise<MobileTerminal[]> {
    return request<{ terminals: MobileTerminal[] }>('/api/terminals').then(
        (r) => r.terminals,
    );
}

export function listQuestions(): Promise<PendingQuestion[]> {
    return request<{ questions: PendingQuestion[] }>('/api/questions').then(
        (r) => r.questions,
    );
}

// ---- REST writes ----------------------------------------------------------

/** Start / stop / restart a background process. Returns the fresh list. */
export function processAction(
    id: string,
    action: ProcessAction,
): Promise<ProcessListItem[]> {
    return request<{ ok: boolean; processes: ProcessListItem[] }>(
        `/api/process/${encodeURIComponent(id)}/${action}`,
        { method: 'POST' },
    ).then((r) => r.processes);
}

export function createTerminal(input: {
    workspaceId: string;
    cwd?: string;
    label?: string;
}): Promise<{ id: string; scrollback: string }> {
    return request<{ id: string; scrollback: string }>('/api/terminal/create', {
        method: 'POST',
        json: input,
    });
}

export function killTerminal(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
        `/api/terminal/${encodeURIComponent(id)}/kill`,
        { method: 'POST' },
    );
}

/**
 * Answer a pending ForceTheQuestion. `answered:false` is a benign race — the
 * desktop (or another phone) already answered it — and the UI treats it as a
 * success that simply dismisses the question.
 */
export function answer(
    id: string,
    answers: ForceAnswerSpec[],
): Promise<{ ok: true; answered: boolean }> {
    return request<{ ok: true; answered: boolean }>(
        `/api/questions/${encodeURIComponent(id)}/answer`,
        { method: 'POST', json: { answers } },
    );
}

/**
 * Upload a file into a workspace's `.ai/` directory. Reads the File to base64
 * in the browser and POSTs `{name, dataBase64}` to the workspace upload route.
 * The server path-traversal-guards the name, caps the size, and never
 * overwrites (a colliding name rolls to ` (n)`), returning the path it wrote.
 */
export async function uploadToAi(
    workspaceId: string,
    file: File,
): Promise<{ ok: true; path: string }> {
    const dataBase64 = await fileToBase64(file);
    return request<{ ok: true; path: string }>(
        `/api/workspace/${encodeURIComponent(workspaceId)}/upload`,
        { method: 'POST', json: { name: file.name, dataBase64 } },
    );
}

/** Read a File's bytes to a base64 string (no data: URL prefix). */
function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.onload = () => {
            const result = String(reader.result ?? '');
            // FileReader.readAsDataURL yields `data:<mime>;base64,<payload>`.
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.readAsDataURL(file);
    });
}

// ---- WebSocket: dashboard events -----------------------------------------

/** Build a same-origin ws:// (or wss://) URL with the session token attached. */
function wsUrl(path: string, params: Record<string, string> = {}): string {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams(params);
    const token = getToken();
    if (token) qs.set('token', token);
    return `${proto}//${loc.host}${path}?${qs.toString()}`;
}

/**
 * Connect to `/ws/events` and stream dashboard pushes to `onEvent`. Reconnects
 * with capped exponential backoff (1s → 15s) on any drop. Returns a `close()`
 * that stops the stream AND cancels any pending reconnect.
 *
 * A close code of 1008 (policy violation) is how the server rejects a dead
 * token on upgrade; we treat it as needs-pair rather than looping forever.
 */
export function connectEvents(onEvent: (e: MobileEvent) => void): {
    close: () => void;
} {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
        if (closed) return;
        if (!getToken()) {
            // No token — nothing to authenticate. The shell will reconnect us
            // after a successful pair via a fresh connectEvents call.
            return;
        }
        try {
            ws = new WebSocket(wsUrl('/ws/events'));
        } catch {
            scheduleReconnect();
            return;
        }
        ws.onopen = () => {
            attempt = 0;
        };
        ws.onmessage = (ev) => {
            try {
                const data = JSON.parse(String(ev.data)) as MobileEvent;
                if (data && typeof data.type === 'string') onEvent(data);
            } catch {
                /* ignore malformed frames */
            }
        };
        ws.onclose = (ev) => {
            ws = null;
            if (closed) return;
            if (ev.code === 1008) {
                // Server rejected the token on upgrade — re-pair, don't retry.
                fireNeedsPair();
                return;
            }
            scheduleReconnect();
        };
        ws.onerror = () => {
            // onclose follows; let it drive the reconnect.
            try {
                ws?.close();
            } catch {
                /* already closing */
            }
        };
    };

    const scheduleReconnect = () => {
        if (closed || reconnectTimer) return;
        const delay = Math.min(15_000, 1_000 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            open();
        }, delay);
    };

    open();

    return {
        close: () => {
            closed = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            try {
                ws?.close();
            } catch {
                /* already closing */
            }
            ws = null;
        },
    };
}

// ---- WebSocket: terminal bridge ------------------------------------------

export interface TerminalConnection {
    /** Send raw bytes (xterm onData) up to the pty. */
    sendInput: (data: string) => void;
    /** Tell the pty the viewport size changed. */
    sendResize: (cols: number, rows: number) => void;
    /** Detach. Viewer-only — never kills the pty. */
    close: () => void;
}

/**
 * Attach to a terminal's pty byte stream over `/ws/term?terminal=<id>`.
 * Down-messages route to the callbacks: `data` (incl. catch-up scrollback on
 * attach), `dropped` (backpressure marker — show "[output dropped]"), and
 * `exit`. Reconnects with backoff; on reattach the server replays scrollback
 * so the viewport catches up. Detaching never kills the pty.
 */
export function connectTerminal(
    terminalId: string,
    cbs: {
        onData: (data: string) => void;
        onDropped: () => void;
        onExit: (info: { exitCode?: number; signal?: number }) => void;
    },
): TerminalConnection {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // The latest resize, replayed on (re)connect so a pty that came up after a
    // rotate still gets the right grid.
    let lastSize: { cols: number; rows: number } | null = null;

    const send = (msg: unknown) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(msg));
            } catch {
                /* socket died mid-send — reconnect will catch it up */
            }
        }
    };

    const open = () => {
        if (closed) return;
        if (!getToken()) return;
        try {
            ws = new WebSocket(
                wsUrl('/ws/term', { terminal: terminalId }),
            );
        } catch {
            scheduleReconnect();
            return;
        }
        ws.onopen = () => {
            attempt = 0;
            // Re-assert the viewport size so a freshly-attached pty matches.
            if (lastSize) send({ type: 'resize', ...lastSize });
        };
        ws.onmessage = (ev) => {
            let msg: TermDownMessage;
            try {
                msg = JSON.parse(String(ev.data)) as TermDownMessage;
            } catch {
                return;
            }
            if (msg.type === 'data') cbs.onData(msg.data);
            else if (msg.type === 'dropped') cbs.onDropped();
            else if (msg.type === 'exit')
                cbs.onExit({ exitCode: msg.exitCode, signal: msg.signal });
        };
        ws.onclose = (ev) => {
            ws = null;
            if (closed) return;
            if (ev.code === 1008) {
                fireNeedsPair();
                return;
            }
            scheduleReconnect();
        };
        ws.onerror = () => {
            try {
                ws?.close();
            } catch {
                /* already closing */
            }
        };
    };

    const scheduleReconnect = () => {
        if (closed || reconnectTimer) return;
        const delay = Math.min(15_000, 1_000 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            open();
        }, delay);
    };

    open();

    return {
        sendInput: (data) => send({ type: 'input', data }),
        sendResize: (cols, rows) => {
            lastSize = { cols, rows };
            send({ type: 'resize', cols, rows });
        },
        close: () => {
            closed = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            try {
                ws?.close();
            } catch {
                /* already closing */
            }
            ws = null;
        },
    };
}
