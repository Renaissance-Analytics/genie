import { WebSocket } from 'ws';

import {
    encodePong,
    encodeSubscribe,
    isIssueWatchDelta,
    isPing,
    isSubscriptionSucceeded,
    parsePusherFrame,
    pusherWsUrl,
    socketIdFrom,
    toIssueWatchDelta,
    workstationChannel,
} from './pusher-protocol';
import type { IssueWatchDeltaPush } from './workspace-assignment';

/** The minimal socket surface the transport drives — the real `ws` WebSocket
 *  satisfies it; tests pass a fake. */
export interface WebSocketLike {
    on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
    send(data: string): void;
    close(): void;
}

/** The host proof-of-possession source — `readWorkstationIdentity()` satisfies it
 *  directly (its `authHeader(now?)` is call-compatible with `authHeader()`). */
export interface WorkstationSigner {
    /** `Authorization: Workstation <ts>:<sig>` for this workstation's own channel. */
    authHeader(): string;
}

export interface WorkstationPusherHandlers {
    /** Fires on every (re)connect — the one-shot reconcile trigger. */
    onConnected: () => void;
    /** Fires per pushed `issuewatch.delta` for this workstation's channel. */
    onIssueWatchDelta: (delta: IssueWatchDeltaPush) => void;
    onDisconnected?: () => void;
}

export interface WorkstationPusherTransportOptions {
    appKey: string;
    cluster: string;
    /** Tynn API base — the broadcasting-auth endpoint the channel is authorized at. */
    tynnApiBaseUrl: string;
    /**
     * The private channel to hold. Optional: when omitted it defaults to this
     * workstation's OWN `private-workstation.{id}` channel (the original path).
     * A caller riding a different channel (e.g. the user's personal
     * `private-App.Models.User.{id}`) supplies it explicitly.
     */
    channel?: string;
    /**
     * Custom channel authorizer for `socket_id` → auth string. Optional: when set
     * it REPLACES the built-in host-proof `POST .../workstations/{id}/broadcasting-auth`,
     * so a caller can authorize a different channel however it must (e.g. a
     * session-cookie POST to `/api/v1/user/broadcasting-auth`). When omitted the
     * built-in host-proof path runs and `workstationId` + `signer` are required.
     */
    authorize?: (socketId: string) => Promise<string>;
    /** Required only for the built-in host-proof auth path (no `authorize`). */
    workstationId?: string;
    /** Required only for the built-in host-proof auth path (no `authorize`). */
    signer?: WorkstationSigner;
    /** Injectable socket + fetch for tests; default to real `ws` + global fetch. */
    wsFactory?: (url: string) => WebSocketLike;
    fetchImpl?: typeof fetch;
    /** Delay before re-dialing after a drop (ms). Not a poll — reconnect only. */
    reconnectDelayMs?: number;
    log?: (msg: string) => void;
}

/** A live subscription — closing it drops the ONE persistent connection. */
export interface WorkstationSubscriptionHandle {
    close(): void;
}

/**
 * ONE persistent Pusher private-channel subscription for a LOCAL workstation =
 * the server-side IssueWatch push carrier. Lifted from genie-cloud's
 * `PusherAssignmentTransport` (same lifecycle — never polls: holds a single
 * socket, answers Pusher's idle pings, and only re-dials once after a drop), but
 * scoped to the IssueWatch delta path a local self-registered workstation needs.
 * Each (re)establish re-subscribes and fires `onConnected` so the caller
 * reconciles the snapshot.
 */
export class WorkstationPusherTransport {
    private ws: WebSocketLike | null = null;
    private closed = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private handlers: WorkstationPusherHandlers | null = null;

    private readonly channel: string;

    constructor(private readonly opts: WorkstationPusherTransportOptions) {
        if (opts.channel) {
            this.channel = opts.channel;
        } else if (opts.workstationId) {
            this.channel = workstationChannel(opts.workstationId);
        } else {
            throw new Error('WorkstationPusherTransport requires a `channel` or a `workstationId`');
        }
    }

    open(handlers: WorkstationPusherHandlers): WorkstationSubscriptionHandle {
        this.handlers = handlers;
        this.dial();
        return {
            close: () => {
                this.closed = true;
                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
                try {
                    this.ws?.close();
                } catch {
                    /* already closing */
                }
                this.ws = null;
            },
        };
    }

    private dial(): void {
        if (this.closed) return;
        const url = pusherWsUrl(this.opts.appKey, this.opts.cluster);
        const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
        let ws: WebSocketLike;
        try {
            ws = factory(url);
        } catch (e) {
            this.log(`dial failed: ${errMsg(e)}`);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.on('message', (raw: unknown) => this.onMessage(String(raw)));
        ws.on('close', () => this.onDrop());
        ws.on('error', (e: unknown) => {
            this.log(`socket error: ${errMsg(e)}`);
            // 'close' follows an 'error'; reconnect is scheduled there.
        });
    }

    private onMessage(raw: string): void {
        const frame = parsePusherFrame(raw);
        if (!frame || !this.ws) return;

        const socketId = socketIdFrom(frame);
        if (socketId) {
            // Authorize the private channel, then subscribe. Async — a failure just
            // drops the socket, and the reconnect path retries.
            void this.authorizeAndSubscribe(socketId);
            return;
        }
        if (isPing(frame)) {
            this.safeSend(encodePong());
            return;
        }
        if (isSubscriptionSucceeded(frame, this.channel)) {
            // Live (or re-established) — the caller reconciles the snapshot now.
            this.handlers?.onConnected();
            return;
        }
        if (isIssueWatchDelta(frame, this.channel)) {
            const delta = toIssueWatchDelta(frame.data);
            if (delta) this.handlers?.onIssueWatchDelta(delta);
        }
    }

    private async authorizeAndSubscribe(socketId: string): Promise<void> {
        try {
            const auth = this.opts.authorize
                ? await this.opts.authorize(socketId)
                : await this.fetchChannelAuth(socketId);
            this.safeSend(encodeSubscribe(this.channel, auth));
        } catch (e) {
            this.log(`channel auth failed: ${errMsg(e)}`);
            try {
                this.ws?.close(); // triggers reconnect
            } catch {
                /* */
            }
        }
    }

    /** POST the host proof to Tynn's broadcasting-auth for this socket + channel.
     *  Only reached on the built-in path (no `authorize`), where `workstationId`
     *  and `signer` are required. */
    private async fetchChannelAuth(socketId: string): Promise<string> {
        const { workstationId, signer } = this.opts;
        if (!workstationId || !signer) {
            throw new Error('host-proof channel auth requires `workstationId` and `signer`');
        }
        const fetchImpl = this.opts.fetchImpl ?? fetch;
        const base = this.opts.tynnApiBaseUrl.replace(/\/+$/, '');
        const url = `${base}/api/v1/workstations/${encodeURIComponent(workstationId)}/broadcasting-auth`;
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                authorization: signer.authHeader(),
            },
            body: JSON.stringify({ socket_id: socketId, channel_name: this.channel }),
        });
        if (!res.ok) throw new Error(`broadcasting-auth HTTP ${res.status}`);
        const body = (await res.json()) as { auth?: unknown };
        if (typeof body.auth !== 'string' || body.auth === '') {
            throw new Error('broadcasting-auth returned no auth');
        }
        return body.auth;
    }

    private onDrop(): void {
        this.ws = null;
        // An intentional close() (e.g. sign-out) already set its own terminal
        // state and nulled the socket. Firing onDisconnected here would clobber
        // that state ('signed-out' → 'disconnected') and scheduleReconnect would
        // no-op anyway — so bail before touching either.
        if (this.closed) return;
        // A real drop always schedules a re-dial, so this is "reconnecting", not
        // a terminal failure — the caller maps onDisconnected to a connecting
        // state, reserving 'disconnected' for give-up paths (no config / startup).
        this.handlers?.onDisconnected?.();
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer) return;
        const delay = this.opts.reconnectDelayMs ?? 5000;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.dial();
        }, delay);
        this.reconnectTimer.unref?.();
    }

    private safeSend(data: string): void {
        try {
            this.ws?.send(data);
        } catch (e) {
            this.log(`send failed: ${errMsg(e)}`);
        }
    }

    private log(msg: string): void {
        this.opts.log?.(`[workstation-transport] ${msg}`);
    }
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
