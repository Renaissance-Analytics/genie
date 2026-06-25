import type { WebSocket } from 'ws';

/**
 * Main-side event bus for the mobile dashboard push channel (`/ws/events`).
 *
 * `mobileEmit(event, payload)` fans a JSON message out to every connected
 * dashboard socket. It's wired into the SAME broadcast helpers that already push
 * to renderer windows (terminal:attention, workspace:pulse, process:status,
 * terminal-spec:changed, workspaces:changed) plus the force-question
 * question:new / question:resolved signals — each gets ONE added mobileEmit(…)
 * line alongside its existing renderer broadcast.
 *
 * Crucially this is a NO-OP when the mobile server is off (no registered fanout),
 * so the one-liners added to ipc.ts / process-supervisor.ts cost nothing and are
 * safe to call unconditionally on every event.
 *
 * The terminal BYTE stream uses a SEPARATE channel (`/ws/term`, see
 * terminal-bridge.ts) so a slow terminal socket can't stall dashboard pushes.
 */

/** The set of live dashboard sockets. Registered by server.ts on upgrade. */
let eventSockets: Set<WebSocket> | null = null;

/** A dashboard push message. `type` discriminates; `payload` is event-specific. */
export interface MobileEvent {
    type: string;
    payload?: unknown;
}

/** Point the bus at the server's live `/ws/events` socket set (or null = off). */
export function setEventSockets(sockets: Set<WebSocket> | null): void {
    eventSockets = sockets;
}

/**
 * Fan an event out to every dashboard socket. No-op when the server is off.
 * Guarded per-socket so one dead socket can't abort the broadcast.
 */
export function mobileEmit(type: string, payload?: unknown): void {
    const sockets = eventSockets;
    if (!sockets || sockets.size === 0) return;
    const msg = JSON.stringify({ type, payload });
    for (const ws of sockets) {
        // 1 === OPEN. Avoid importing ws's enum just for the constant.
        if (ws.readyState !== 1) continue;
        try {
            ws.send(msg);
        } catch {
            /* socket went away mid-send — the close handler drops it */
        }
    }
}
