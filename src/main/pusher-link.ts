import { encodePong, encodeSubscribe, parsePusherFrame, pusherErrorOf, pusherSubscriptionErrorOf, socketIdOf, type PusherFrame } from '../core/pusher.js';
import type { SocketLike } from './issue-watch-client.js';

/** How long a dialled socket may say nothing before it counts as failed. */
export const CONNECT_DEADLINE_MS = 15_000;
/** How long, from asking for its signature, a channel's subscribe may go unanswered before the socket counts as failed. */
export const SUBSCRIBE_DEADLINE_MS = 30_000;

const said = (text: string): string => text.slice(0, 200);

export interface PusherLinkHandlers {
    onEstablished(socketId: string): void;
    onSubscribed(channel: string): void;
    /** The server refused this channel only (`pusher:subscription_error`); the socket is still up. */
    onSubscriptionRefused(channel: string, reason: string): void;
    /** Anything else that came on the socket. */
    onEvent(frame: PusherFrame): void;
    /** The socket has failed or dropped and is let go. `null` = it dropped after connecting, with nothing to say. */
    onEnded(reason: string | null): void;
}

/**
 * ONE SOCKET TO TYNN'S SOCKET SERVER, AND EVERY WAY IT CAN FAIL WITHOUT SAYING SO (genie#1478): IssueWatch and the live board.
 *
 * Production's Reverb refuses with a frame and then leaves the socket open and silent. It refuses a bad Origin that way (4009
 * `Origin not allowed`) and a bad signature too (4009 `Connection is unauthorized`, no channel on it: measured, not the
 * protocol's `pusher:subscription_error`, which is still handled for a Pusher). So nothing here waits on a close:
 *
 *  - `pusher:error` ends the link, with its reason;
 *  - `connection_established` has a deadline, and so has each channel from when its signature is asked for;
 *  - a link that has ended is deaf: a late frame or close does nothing, and its timers are gone.
 *
 * What to do next (backoff, what to tell the person) is each client's.
 */
export class PusherLink {
    readonly #socket: SocketLike;
    readonly #schedule: (fn: () => void, ms: number) => () => void;
    readonly #handlers: PusherLinkHandlers;
    readonly #subscribes = new Map<string, () => void>();
    #cancelConnect: (() => void) | null;
    #ended = false;
    #established = false;
    #socketError: string | null = null;

    constructor(socket: SocketLike, schedule: (fn: () => void, ms: number) => () => void, handlers: PusherLinkHandlers) {
        this.#socket = socket;
        this.#schedule = schedule;
        this.#handlers = handlers;
        this.#cancelConnect = schedule(() => { this.fail(`Tynn's socket server said nothing for ${CONNECT_DEADLINE_MS / 1000} s`); }, CONNECT_DEADLINE_MS);
        socket.addEventListener('message', (e) => { if (!this.#ended) this.#onMessage(String(e.data)); });
        socket.addEventListener('close', () => {
            if (this.#ended) return;
            this.#end();
            handlers.onEnded(this.#established ? null : `Tynn's socket closed before it connected${this.#socketError === null ? '' : `: ${this.#socketError}`}`);
        });
        // A 'close' follows, and the link ends there; what went wrong is only said here.
        socket.addEventListener('error', (e) => { if (typeof e.message === 'string' && e.message !== '') this.#socketError = e.message; });
    }

    /** Still up: false once it has failed, dropped or been closed. */
    get active(): boolean {
        return !this.#ended;
    }

    /** How many channels are waiting on their answer. */
    get pendingSubscribes(): number {
        return this.#subscribes.size;
    }

    /** A channel's subscribe is under way, from before it is signed: a signature that never comes is the same silence. */
    expectSubscribe(channel: string): void {
        if (this.#ended || this.#subscribes.has(channel)) return;
        this.#subscribes.set(channel, this.#schedule(() => {
            this.fail(`Tynn's socket server did not confirm the subscription within ${SUBSCRIBE_DEADLINE_MS / 1000} s`);
        }, SUBSCRIBE_DEADLINE_MS));
    }

    subscribe(channel: string, auth: string): void {
        if (this.#ended) return;
        this.expectSubscribe(channel);
        this.#socket.send(encodeSubscribe(channel, auth));
    }

    /** Nothing more is expected of this channel. */
    forget(channel: string): void {
        this.#subscribes.get(channel)?.();
        this.#subscribes.delete(channel);
    }

    /** This socket has failed: let it go now. Its close may never come, and is ignored if it does. */
    fail(reason: string): void {
        if (this.#ended) return;
        this.#end();
        this.#handlers.onEnded(reason);
    }

    /** Let it go, with nothing to report: the client is done with it. */
    close(): void {
        if (!this.#ended) this.#end();
    }

    #end(): void {
        this.#ended = true;
        this.#cancelConnect?.();
        this.#cancelConnect = null;
        for (const cancel of this.#subscribes.values()) cancel();
        this.#subscribes.clear();
        try { this.#socket.close(); } catch { /* already closing */ }
    }

    #onMessage(raw: string): void {
        const frame = parsePusherFrame(raw);
        if (!frame) return;
        const refused = pusherErrorOf(frame);
        if (refused !== null) {
            this.fail(`Tynn's socket server refused the connection: ${said(refused.message)}${refused.code === null ? '' : ` (${refused.code})`}`);
            return;
        }
        const socketId = socketIdOf(frame);
        if (socketId !== null) {
            this.#established = true;
            this.#cancelConnect?.();
            this.#cancelConnect = null;
            this.#handlers.onEstablished(socketId);
            return;
        }
        if (frame.event === 'pusher:ping') {
            try { this.#socket.send(encodePong()); } catch { /* it is closing: its close says so */ }
            return;
        }
        if (frame.event === 'pusher_internal:subscription_succeeded' && frame.channel !== undefined) {
            this.forget(frame.channel);
            this.#handlers.onSubscribed(frame.channel);
            return;
        }
        const channelRefused = frame.channel === undefined ? null : pusherSubscriptionErrorOf(frame);
        if (channelRefused !== null) {
            this.forget(frame.channel!);
            this.#handlers.onSubscriptionRefused(frame.channel!, `Tynn's socket server refused the channel: ${said(channelRefused.message)}${channelRefused.status === null ? '' : ` (${channelRefused.status})`}`);
            return;
        }
        this.#handlers.onEvent(frame);
    }
}
