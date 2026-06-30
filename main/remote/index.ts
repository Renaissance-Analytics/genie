import { app, BrowserWindow, Notification, safeStorage } from 'electron';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { demandWindowAttention } from '../attention-flash';
import { getAllSettings } from '../db';
import { resolveAlertSound } from '../notify-sound';
import { shouldForwardToDriver } from './forward-decision';
import {
    raiseForwardedQuestion,
    dismissForwardedQuestion,
    dismissForwardedQuestionsForConn,
    type PendingQuestion,
} from '../ask/force-question';

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
 * here, so the renderer can't leak it. A window is remote ONLY if it was
 * explicitly bound (the host-window factory); every other window stays local, so
 * connecting a host never flips the local desktop.
 */

export interface RemoteHost {
    ip: string;
    port: number;
    hostname: string;
}

/** After this many consecutive `/ws/events` reconnects that never reach `open`
 *  (the host keeps rejecting the upgrade — e.g. a dead token → HTTP 401), stop
 *  the silent reconnect-storm and tear the connection down so it recovers
 *  (the host window auto-closes on the resulting disconnect). ~10s at 2s spacing. */
const MAX_EVENTS_FAILURES = 5;

/** A live connection to one host. Self-contained: token + events bridge + ptys. */
interface RemoteConnection {
    host: RemoteHost;
    /** `ip:port` — the registry key + token-store key. */
    connKey: string;
    token: string;
    eventsWs: WebSocket | null;
    eventsClosed: boolean;
    eventsRetry: NodeJS.Timeout | null;
    /** Consecutive events-WS opens that failed (reset to 0 on a real `open`). */
    eventsFailures: number;
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

// --- known hosts (the Hosts picker's persisted list) -----------------------
// A host you've paired with is REMEMBERED so it shows in the picker even when
// tailnet discovery finds nothing right now (host asleep / off the tailnet), and
// can carry a friendly name. Stored separately from the (secret) token store.

export interface KnownHost {
    ip: string;
    port: number;
    hostname: string;
    /** User-chosen label; falls back to hostname in the UI. */
    name?: string;
}

function knownHostsPath(): string {
    return path.join(app.getPath('userData'), 'genie-remote-hosts.json');
}
function readKnownHosts(): Record<string, KnownHost> {
    try {
        return JSON.parse(fs.readFileSync(knownHostsPath(), 'utf8')) as Record<string, KnownHost>;
    } catch {
        return {};
    }
}
function writeKnownHosts(store: Record<string, KnownHost>): void {
    try {
        fs.writeFileSync(knownHostsPath(), JSON.stringify(store), 'utf8');
    } catch {
        /* best-effort persistence */
    }
}

/** Remember a host in the picker list (called on a successful connect). Keeps any
 *  existing friendly name; refreshes ip/hostname in case they changed. */
export function recordKnownHost(host: RemoteHost): void {
    const store = readKnownHosts();
    const key = connKeyOf(host);
    store[key] = { ...store[key], ip: host.ip, port: host.port, hostname: host.hostname };
    writeKnownHosts(store);
}

/** The persisted known hosts, each tagged with whether it's currently connected. */
export function listKnownHosts(): Array<KnownHost & { connKey: string; connected: boolean }> {
    const store = readKnownHosts();
    return Object.entries(store).map(([connKey, h]) => ({
        ...h,
        connKey,
        connected: connections.has(connKey),
    }));
}

/** Set a host's friendly name (or clear it with ''). */
export function renameKnownHost(connKey: string, name: string): void {
    const store = readKnownHosts();
    if (!store[connKey]) return;
    store[connKey] = { ...store[connKey], name: name.trim() || undefined };
    writeKnownHosts(store);
}

/** Forget a host: disconnect it, drop its saved token, and remove it from the
 *  picker list. The next connect needs the PIN again. */
export function forgetHost(connKey: string): void {
    disconnectConnKey(connKey);
    const tokens = readTokenStore();
    delete tokens[connKey];
    writeTokenStore(tokens);
    const known = readKnownHosts();
    delete known[connKey];
    writeKnownHosts(known);
}

// --- window ↔ connection resolution ----------------------------------------

/**
 * The connection a CALLING window should use, or null when it's LOCAL. A window
 * is remote ONLY if it was explicitly bound (the host-window factory). Every
 * other window — the local window, Settings, a Stage — is local, so connecting a
 * host never flips them: that's the whole point of multi-host coexistence.
 */
function connForWebContents(wcId: number): RemoteConnection | null {
    const key = bindings.get(wcId);
    return key ? connections.get(key) ?? null : null;
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

/** Is this window bound to a remote host (i.e. a host window)? The predicate
 *  `broadcastLocal` uses to keep LOCAL-machine events out of host windows. */
export function isRemoteBoundWindow(wcId: number): boolean {
    return bindings.has(wcId);
}

/**
 * Broadcast a LOCAL-machine IPC event to every window EXCEPT host windows (those
 * bound to a remote connection). A host window's UI reflects the HOST, so a
 * local mutation must not reach it: shared ids (the Tynn `project.id`,
 * `__system__`) would otherwise make it navigate, glow, or refetch wrongly.
 * Host windows get their live events from `emitToConn` (the host's `/ws/events`).
 */
export function broadcastLocal(channel: string, payload?: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.isDestroyed()) continue;
        if (isRemoteBoundWindow(w.webContents.id)) continue;
        w.webContents.send(channel, payload);
    }
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

/** Send a connection's events ONLY to the windows bound to it — so a host's
 *  data never reaches the local window or another host's window. */
function emitToConn(conn: RemoteConnection, channel: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        if (bindings.get(w.webContents.id) === conn.connKey) {
            w.webContents.send(channel, payload);
        }
    }
}

/** Flash the OS window(s) bound to this connection (the host windows viewing
 *  it) when unfocused — used when a remote agent on the host calls imDone. */
function flashConnWindows(conn: RemoteConnection): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        if (bindings.get(w.webContents.id) === conn.connKey) demandWindowAttention(w);
    }
}

// --- forward host alerts/prompts to the driving member ----------------------
// When this Genie drives a host with CONTROL, the host's ForceTheQuestion
// prompts + imDone chime/toast must reach THIS driver (the glow + window-flash
// already arrive via terminal:attention). The host pushes `question:changed` /
// `notify:imdone` over /ws/events; we mirror the modal locally (answer → POST
// back) and surface the chime/toast here.

/** A Bearer-token REST call to a SPECIFIC host connection (best-effort; the
 *  events bridge owns disconnect, so this never tears the connection down). */
async function connRequest(
    conn: RemoteConnection,
    reqPath: string,
    init?: { method?: string; json?: unknown },
): Promise<unknown> {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.status === 204) return undefined;
    return res.json().catch(() => undefined);
}

/** connKey → host question ids we've raised a local forwarded modal for. */
const forwardedShown = new Map<string, Set<string>>();

/**
 * Reconcile the host's pending ForceTheQuestion list with our local forwarded
 * modals: raise a modal for each NEW host question (the driver answers → POST
 * the answer back), and dismiss any we showed that the host has since resolved
 * (first-answer-wins). Driven by the host's `question:changed` push + once on
 * connect. No-op for a readonly driver (it can't act on a control prompt).
 */
async function syncForwardedQuestions(conn: RemoteConnection): Promise<void> {
    // Today every connection is a control driver; the grant model (later phase)
    // supplies readonly, at which point this guard stops forwarding actionable
    // prompts to a viewer.
    if (!shouldForwardToDriver({ connected: true, capability: 'control' })) return;
    let pending: PendingQuestion[];
    try {
        const data = (await connRequest(conn, '/api/questions')) as {
            questions?: PendingQuestion[];
        };
        pending = data?.questions ?? [];
    } catch {
        return; // host unreachable / transient — try again on the next push
    }
    const shown = forwardedShown.get(conn.connKey) ?? new Set<string>();
    forwardedShown.set(conn.connKey, shown);
    const pendingIds = new Set(pending.map((q) => q.id));

    // Raise newly-pending host questions as local modals.
    for (const q of pending) {
        if (shown.has(q.id)) continue;
        shown.add(q.id);
        void raiseForwardedQuestion({
            connKey: conn.connKey,
            hostId: q.id,
            questions: q.questions,
            workspaceLabel: q.workspaceLabel,
        }).then((result) => {
            shown.delete(q.id);
            // Only an actual answer goes back to the host. A cancel (the driver
            // dismissed it, OR the host resolved it first → we dismissed locally)
            // posts nothing — the host owner stays in control.
            if (!result.cancelled) {
                void connRequest(conn, `/api/questions/${encodeURIComponent(q.id)}/answer`, {
                    method: 'POST',
                    json: { answers: result.answers },
                }).catch(() => {});
            }
        });
    }
    // Dismiss modals the host has resolved out from under us.
    for (const hostId of [...shown]) {
        if (!pendingIds.has(hostId)) {
            shown.delete(hostId);
            dismissForwardedQuestion(conn.connKey, hostId);
        }
    }
}

/** Surface a host's imDone chime + toast on THIS driver (the glow + window-flash
 *  arrive separately via terminal:attention). Honours the DRIVER's own
 *  notify_sound / notify_toast settings. */
function forwardImDoneToDriver(conn: RemoteConnection, payload: { label?: string } | null): void {
    let settings;
    try {
        settings = getAllSettings();
    } catch {
        return;
    }
    if (settings.notify_sound === 'on') {
        const sound = resolveAlertSound('imDone');
        // Play in the bound host window's renderer (it subscribes to notify:sound).
        if (sound) emitToConn(conn, 'notify:sound', { kind: 'imDone', sound });
    }
    if (settings.notify_toast === 'on' && Notification.isSupported()) {
        const label = payload?.label ?? 'A terminal';
        const n = new Notification({
            title: 'Genie — agent finished (remote)',
            body: `${label} is done on ${conn.host.hostname}.`,
            silent: settings.notify_sound === 'on',
        });
        n.on('click', () => {
            for (const w of BrowserWindow.getAllWindows()) {
                if (w.isDestroyed()) continue;
                if (bindings.get(w.webContents.id) === conn.connKey) {
                    w.show();
                    w.focus();
                    break;
                }
            }
        });
        n.show();
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
        // A real upgrade reached the host → healthy; clear the failure streak.
        // Sync any questions the host ALREADY had pending before we connected so
        // a forwarded modal isn't missed (the `question:changed` push only fires
        // on a CHANGE, not on connect).
        ws.on('open', () => {
            conn.eventsFailures = 0;
            void syncForwardedQuestions(conn);
        });
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(String(raw)) as { type?: string; payload?: unknown };
                if (msg.type && PASSTHROUGH_EVENTS.has(msg.type)) {
                    emitToConn(conn, msg.type, msg.payload);
                    // A remote agent on THIS host asked for attention (imDone
                    // glow). Flash the OS window(s) viewing this host — not the
                    // master, not another host's window — when they're not
                    // focused, so the right window among several is identifiable.
                    if (
                        msg.type === 'terminal:attention' &&
                        (msg.payload as { on?: boolean } | null)?.on
                    ) {
                        flashConnWindows(conn);
                    }
                    return;
                }
                // Host alerts/prompts forwarded to the driving member (handled in
                // MAIN, not re-emitted to the renderer): mirror the host's
                // ForceTheQuestion modal locally + carry the imDone chime/toast.
                if (msg.type === 'question:changed') {
                    void syncForwardedQuestions(conn);
                } else if (msg.type === 'notify:imdone') {
                    forwardImDoneToDriver(conn, msg.payload as { label?: string } | null);
                }
            } catch {
                /* ignore malformed frames */
            }
        });
        ws.on('close', () => {
            if (conn.eventsWs === ws) conn.eventsWs = null;
            if (conn.eventsClosed) return;
            // A close WITHOUT a preceding healthy `open` (the streak wasn't reset)
            // means the host keeps rejecting us — a dead token (HTTP 401 upgrade),
            // a lock, etc. Past the cap, stop the silent reconnect-storm and tear
            // the connection down so it recovers (the host window auto-closes).
            conn.eventsFailures += 1;
            if (conn.eventsFailures >= MAX_EVENTS_FAILURES) {
                teardownConnection(conn);
                broadcastStatus();
                return;
            }
            scheduleRetry();
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
type ConnectResult = { ok: boolean; connKey?: string; error?: string; needsPin?: boolean };

/** In-flight connect promises keyed by connKey — so two concurrent connects for
 *  the SAME host share one attempt instead of racing (the loser would otherwise
 *  orphan the winner's eventsWs, which reconnects forever with no owner). */
const connectInFlight = new Map<string, Promise<ConnectResult>>();

export async function connectRemote(host: RemoteHost, pin?: string): Promise<ConnectResult> {
    const connKey = connKeyOf(host);

    // Already connected to this host → reuse it (a host window re-open / a second
    // request for the same host shares the one connection).
    if (connections.has(connKey)) return { ok: true, connKey };
    // A connect for this host is already in flight → join it (no duplicate conn).
    const inFlight = connectInFlight.get(connKey);
    if (inFlight) return inFlight;

    const run = connectRemoteInner(host, pin, connKey);
    connectInFlight.set(connKey, run);
    try {
        return await run;
    } finally {
        connectInFlight.delete(connKey);
    }
}

async function connectRemoteInner(
    host: RemoteHost,
    pin: string | undefined,
    connKey: string,
): Promise<ConnectResult> {
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
        eventsFailures: 0,
        termWs: new Map(),
    };
    connections.set(connKey, conn);
    recordKnownHost(host);
    startEventsBridge(conn);
    broadcastStatus();
    return { ok: true, connKey };
}

/** Tear a single connection down (viewer-only — never touches host terminals). */
function teardownConnection(conn: RemoteConnection): void {
    stopEventsBridge(conn);
    closeAllTerminals(conn);
    connections.delete(conn.connKey);
    // Dismiss any forwarded host-question modals still up for this connection
    // (the bridge is gone — answering them could never reach the host).
    dismissForwardedQuestionsForConn(conn.connKey);
    forwardedShown.delete(conn.connKey);
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

/** Disconnect a connection by its key (the host-window factory calls this when
 *  the last window driving a host closes). No-op when not connected. */
export function disconnectConnKey(connKey: string): void {
    const conn = connections.get(connKey);
    if (conn) {
        teardownConnection(conn);
        broadcastStatus();
    }
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
