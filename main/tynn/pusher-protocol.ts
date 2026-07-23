import type { IssueWatchDeltaPush } from './workspace-assignment';

/**
 * PURE Pusher wire codec for the local workstation's private-channel subscription
 * — no IO, so the frame handling is unit-tested exhaustively; the socket lifecycle
 * lives in the thin adapter (`pusher-transport.ts`). Lifted from
 * `repos/genie-cloud/src/workspace-assignment/pusher-protocol.ts` — the local
 * Genie rides the EXACT hosted path (design brief genie-service-separation §2a),
 * so the codec is shared verbatim; only the IssueWatch coercion is kept (a local
 * self-registered workstation isn't assigned envelopes — it only consumes the
 * server-side IssueWatch deltas).
 *
 * We speak just enough of the Pusher protocol (v7) to hold ONE private-channel
 * subscription: connection_established → socket_id, subscribe with a channel auth,
 * then receive the `issuewatch.delta` events Tynn broadcasts. Ping/pong keeps the
 * idle connection alive (Pusher pings when quiet — no client poll).
 */

export interface PusherFrame {
    event: string;
    channel?: string;
    data?: unknown;
}

/** The wss endpoint for an app key + cluster (Pusher Cloud). */
export function pusherWsUrl(appKey: string, cluster: string): string {
    return `wss://ws-${cluster}.pusher.com/app/${encodeURIComponent(appKey)}?protocol=7&client=genie-local&version=1.0`;
}

/** The private channel Tynn broadcasts a workstation's events on. */
export function workstationChannel(workstationId: string): string {
    return `private-workstation.${workstationId}`;
}

/**
 * The private channel Tynn broadcasts a USER's personal events on — Laravel's
 * default per-model private channel for `App\Models\User`. A personal desktop
 * rides this instead of a self-registered workstation channel (Phase 2b), so it
 * receives the SAME server-side `issuewatch.delta` push with no workstation row.
 */
export function userChannel(userId: string): string {
    return `private-App.Models.User.${userId}`;
}

/**
 * Parse a raw Pusher frame. Pusher double-encodes `data` as a JSON STRING for
 * channel events, so we transparently decode it. Returns null for non-JSON /
 * event-less frames (dropped, never fatal).
 */
export function parsePusherFrame(raw: string): PusherFrame | null {
    let msg: { event?: unknown; channel?: unknown; data?: unknown };
    try {
        msg = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof msg.event !== 'string') return null;
    let data = msg.data;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            /* leave as the raw string */
        }
    }
    return {
        event: msg.event,
        channel: typeof msg.channel === 'string' ? msg.channel : undefined,
        data,
    };
}

export function encodeSubscribe(channel: string, auth: string): string {
    return JSON.stringify({ event: 'pusher:subscribe', data: { auth, channel } });
}

export function encodePong(): string {
    return JSON.stringify({ event: 'pusher:pong', data: {} });
}

/** The `socket_id` from a `pusher:connection_established` frame, else null. */
export function socketIdFrom(frame: PusherFrame): string | null {
    if (frame.event !== 'pusher:connection_established') return null;
    const d = frame.data as { socket_id?: unknown } | undefined;
    return d && typeof d.socket_id === 'string' ? d.socket_id : null;
}

export function isSubscriptionSucceeded(frame: PusherFrame, channel: string): boolean {
    return frame.event === 'pusher_internal:subscription_succeeded' && frame.channel === channel;
}

export function isPing(frame: PusherFrame): boolean {
    return frame.event === 'pusher:ping';
}

/** Is this a server-side IssueWatch delta for OUR channel? (Tynn's broadcastAs —
 *  the counts/items push that lets clients stop polling GitHub.) */
export function isIssueWatchDelta(frame: PusherFrame, channel: string): boolean {
    return frame.event === 'issuewatch.delta' && frame.channel === channel;
}

/**
 * Coerce an untrusted `issuewatch.delta` payload (or a reconcile-snapshot row)
 * into an IssueWatchDeltaPush. Null when it carries no usable workspace id
 * (dropped, never fatal). Counts default to 0; items pass through opaquely (the
 * issue-watch module owns their shape). Mirrors genie-cloud's `toIssueWatchDelta`.
 */
export function toIssueWatchDelta(raw: unknown): IssueWatchDeltaPush | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const workspaceId = str(r.workspaceId) ?? str(r.projectId);
    if (!workspaceId) return null;
    const c = r.counts && typeof r.counts === 'object' ? (r.counts as Record<string, unknown>) : {};
    return {
        workspaceId,
        projectId: str(r.projectId) ?? workspaceId,
        counts: { issue: num(c.issue), pr: num(c.pr), security: num(c.security) },
        items: Array.isArray(r.items) ? r.items : [],
    };
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
