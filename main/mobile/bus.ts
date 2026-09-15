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

/** Resolve the principal driving a socket (null = unidentified). Set by server.ts. */
let principalOfSocket: ((ws: WebSocket) => string | null) | null = null;

/**
 * Decide what ONE socket receives for a push: the payload (possibly narrowed), or
 * undefined to withhold it. Set by server.ts, which knows which sockets belong to
 * a GUEST and judges those by the guest's grant (guest-access.ts). Unset ⇒ every
 * socket gets every push, as before.
 */
export type EventSocketFilter = (ws: WebSocket, type: string, payload: unknown) => unknown;
let filterForSocket: EventSocketFilter | null = null;

/** Install (or clear, with null) the per-socket push filter. */
export function setEventSocketFilter(filter: EventSocketFilter | null): void {
    filterForSocket = filter;
}

/** The serialized message this socket receives, or null to withhold it. */
function messageFor(ws: WebSocket, type: string, payload: unknown): string | null {
    if (!filterForSocket) return JSON.stringify({ type, payload });
    const narrowed = filterForSocket(ws, type, payload);
    return narrowed === undefined ? null : JSON.stringify({ type, payload: narrowed });
}

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
 * Teach the bus which principal each socket belongs to, so a push can be
 * PERSONALISED (`mobileEmitEach`). Needed by the baton: "who is driving" is one
 * fact, but "are YOU view-only" differs per recipient. Null clears the mapping.
 */
export function setEventSocketPrincipal(
    resolve: ((ws: WebSocket) => string | null) | null,
): void {
    principalOfSocket = resolve;
}

/**
 * Fan an event out to every dashboard socket. No-op when the server is off.
 * Guarded per-socket so one dead socket can't abort the broadcast.
 */
export function mobileEmit(type: string, payload?: unknown): number {
    const sockets = eventSockets;
    if (!sockets || sockets.size === 0) return 0;
    let delivered = 0;
    for (const ws of sockets) {
        // 1 === OPEN. Avoid importing ws's enum just for the constant.
        if (ws.readyState !== 1) continue;
        try {
            const msg = messageFor(ws, type, payload);
            if (msg === null) continue;
            ws.send(msg);
            delivered += 1;
        } catch {
            /* socket went away mid-send — the close handler drops it */
        }
    }
    // Sockets that actually took it — see broadcastLocal for why a caller that
    // REPORTS the push to an agent has to look at this.
    return delivered;
}

/**
 * Fan an event out with a payload built PER RECIPIENT from that socket's
 * principal. Used for `control:changed`, where each client needs its own answer
 * to "is someone else driving?" — a single broadcast would tell every non-holder
 * it can drive and then silently drop its keystrokes.
 */
export function mobileEmitEach(
    type: string,
    payloadFor: (principalId: string | null) => unknown,
): void {
    const sockets = eventSockets;
    if (!sockets || sockets.size === 0) return;
    for (const ws of sockets) {
        if (ws.readyState !== 1) continue;
        try {
            const principalId = principalOfSocket ? principalOfSocket(ws) : null;
            const msg = messageFor(ws, type, payloadFor(principalId));
            if (msg !== null) ws.send(msg);
        } catch {
            /* socket went away mid-send — the close handler drops it */
        }
    }
}
