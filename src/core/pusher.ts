/**
 * THE PUSHER PROTOCOL, the part Genie speaks (protocol 7): Tynn broadcasts on Pusher channels (Laravel's `pusher`
 * driver), and Genie listens on the person's own private channel for IssueWatch (Tynn #806). Ported from Genie 1's
 * main/tynn/pusher-protocol.ts, which ran against Tynn in production. Pure: frames in, frames out.
 */

export interface PusherFrame {
    readonly event: string;
    readonly channel?: string | undefined;
    readonly data?: unknown;
}

/** The socket endpoint for an app key and cluster (Pusher's own hosts). */
export function pusherWsUrl(appKey: string, cluster: string): string {
    return `wss://ws-${encodeURIComponent(cluster)}.pusher.com/app/${encodeURIComponent(appKey)}?protocol=7&client=genie&version=2.0`;
}

/**
 * A frame from the socket, or `null` when it is not one. Pusher double-encodes a channel event's `data` as a JSON
 * string; it is decoded here, and left as it was when it is not JSON.
 */
export function parsePusherFrame(raw: string): PusherFrame | null {
    let msg: { event?: unknown; channel?: unknown; data?: unknown };
    try {
        msg = JSON.parse(raw) as typeof msg;
    } catch {
        return null;
    }
    if (msg === null || typeof msg !== 'object' || typeof msg.event !== 'string') return null;
    let data = msg.data;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            // Not JSON: kept as the string it is.
        }
    }
    return { event: msg.event, channel: typeof msg.channel === 'string' ? msg.channel : undefined, data };
}

export function encodeSubscribe(channel: string, auth: string): string {
    return JSON.stringify({ event: 'pusher:subscribe', data: { auth, channel } });
}

export function encodePong(): string {
    return JSON.stringify({ event: 'pusher:pong', data: {} });
}

/** The socket's id, from `pusher:connection_established` — what a private channel's signature is made for. */
export function socketIdOf(frame: PusherFrame): string | null {
    if (frame.event !== 'pusher:connection_established') return null;
    const d = frame.data as { socket_id?: unknown } | undefined;
    return d && typeof d.socket_id === 'string' && d.socket_id.length > 0 ? d.socket_id : null;
}
