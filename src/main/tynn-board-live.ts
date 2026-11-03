import { socketUrlFor, type PusherFrame } from '../core/pusher.js';
import { BOARD_LIVE, liveChannel, liveReconnectDelay, ringIds, type LiveState } from '../core/tynn-board.js';
import type { SocketLike } from './issue-watch-client.js';
import { PusherLink } from './pusher-link.js';

/**
 * THE LIVE BOARD, LISTENING TO TYNN (genie#1295 row B4, workspace-ux 0.5.0 `data.live`).
 *
 * Tynn rings the board's events on the board's own channel (`project-board.{id}`, routes/channels.php: exactly whoever
 * may open the board) as well as on the project's. Genie listens to the board's channel and those SAME events — never a
 * second stream — signed for its socket at the board door with the person's pairing token:
 *
 *   1. `GET  /api/v1/broadcasting-config`                   — where to dial (Reverb or Pusher; the key is public);
 *   2. dial; on `connection_established`, for each open board `POST /api/v1/projects/{id}/broadcasting-auth` signs
 *      `private-project-board.{id}` for THIS socket, for exactly who may open the board — and Genie subscribes;
 *   3. subscribed: live, and a catch-up ring (the tab asks what changed since its cursor), on EVERY (re)subscription;
 *   4. each board event on that channel is a ring for that project, with the ids it names.
 *
 * One socket for every open board. A drop says "reconnecting" and dials again after a growing pause (1 s, doubling, at
 * most 30 s), back to 1 s once live. A board Tynn will not sign (a 404: no board scope, no access, an older Tynn) is
 * "off" and not retried until the next connection; a Tynn with no socket, or no sign-in, is "off". When the last open
 * board closes, the socket closes. Everything outside is a port, so the whole life is tested with a fake socket.
 *
 * The socket can fail without saying so (genie#1478; main/pusher-link.ts holds it): a refusal, or a connect or subscribe that
 * goes unanswered, ends it and it reconnects as a drop does. The reason is only logged: this is a live-update path over data
 * the tab can still fetch. A channel refused alone is that board "off". Production refuses a bad signature for the whole
 * socket instead, so that one reconnects with the rest; the signature is Tynn's own, so it is not expected to be bad.
 */
export interface BoardLiveRing { readonly ids: readonly string[]; readonly catchUp: boolean }

export interface TynnBoardLivePorts {
    /** The signed-in Tynn (requests ride the pairing token); null = signed out. */
    readonly tynn: () => { request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> } | null;
    readonly socket: (url: string) => SocketLike;
    /** Run `fn` after `ms`; answers a cancel. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
    readonly onRing: (projectId: string, ring: BoardLiveRing) => void;
    readonly onState: (projectId: string, state: LiveState) => void;
    /** Why the socket failed. The board is a live-update path over data it can still fetch, so this is only logged. */
    readonly onFailure?: (reason: string) => void;
}

const EVENTS: ReadonlySet<string> = new Set(BOARD_LIVE.events);

export class TynnBoardLive {
    readonly #ports: TynnBoardLivePorts;
    /** Open boards: project → how many tabs follow it. */
    readonly #watchers = new Map<string, number>();
    readonly #states = new Map<string, LiveState>();
    #link: PusherLink | null = null;
    #socketId: string | null = null;
    #attempt = 0;
    #cancelRetry: (() => void) | null = null;
    #dialling = false;

    constructor(ports: TynnBoardLivePorts) {
        this.#ports = ports;
    }

    /** Follow a project's board until the answer is called (one call per open tab). */
    watch(projectId: string): () => void {
        this.#watchers.set(projectId, (this.#watchers.get(projectId) ?? 0) + 1);
        const known = this.#states.get(projectId);
        if (known !== undefined) this.#ports.onState(projectId, known);
        if (this.#link !== null && this.#socketId !== null) {
            if ((this.#watchers.get(projectId) ?? 0) === 1) void this.#subscribe(projectId);
        } else if (this.#link === null && this.#cancelRetry === null && !this.#dialling) {
            void this.#connect();
        }
        let done = false;
        return () => {
            if (done) return;
            done = true;
            const left = (this.#watchers.get(projectId) ?? 1) - 1;
            if (left > 0) { this.#watchers.set(projectId, left); return; }
            this.#watchers.delete(projectId);
            this.#states.delete(projectId);
            // Its subscribe may be out: the answer no longer matters, so its silence must not close the socket under another.
            this.#link?.forget(liveChannel(projectId));
            if (this.#watchers.size === 0) this.#close();
        };
    }

    #set(projectId: string, state: LiveState): void {
        if (!this.#watchers.has(projectId)) return;
        this.#states.set(projectId, state);
        this.#ports.onState(projectId, state);
    }

    #setAll(state: LiveState): void {
        for (const id of this.#watchers.keys()) this.#set(id, state);
    }

    #close(): void {
        this.#cancelRetry?.();
        this.#cancelRetry = null;
        const link = this.#link;
        this.#link = null;
        this.#socketId = null;
        link?.close();
    }

    async #connect(): Promise<void> {
        if (this.#watchers.size === 0) return;
        const tynn = this.#ports.tynn();
        if (tynn === null) { this.#setAll('off'); return; }
        this.#setAll(this.#attempt === 0 ? 'connecting' : 'reconnecting');
        this.#dialling = true;
        let url: string | null;
        try {
            const res = await tynn.request(BOARD_LIVE.push.path, { method: 'GET' });
            if (!res.ok) { this.#dialling = false; return this.#retry(`Tynn answered the push config with HTTP ${res.status}`); }
            url = socketUrlFor((await res.json()) as Parameters<typeof socketUrlFor>[0]);
        } catch (error) {
            this.#dialling = false;
            return this.#retry(`Tynn could not be reached: ${(error as Error).message}`);
        }
        this.#dialling = false;
        if (this.#watchers.size === 0) return;
        // Tynn has no socket to listen on: the board is simply not live.
        if (url === null) { this.#setAll('off'); return; }
        let socket: SocketLike;
        try {
            socket = this.#ports.socket(url);
        } catch (error) {
            return this.#retry(`Tynn's socket could not be dialled: ${(error as Error).message}`);
        }
        const link: PusherLink = new PusherLink(socket, this.#ports.schedule, {
            onEstablished: (socketId) => {
                this.#socketId = socketId;
                for (const id of this.#watchers.keys()) void this.#subscribe(id);
            },
            onSubscribed: (channel) => {
                const projectId = this.#projectOf(channel);
                if (projectId === null) return;
                // Only when every board has answered: one that never does must keep growing the pause, whoever else is live.
                if (link.pendingSubscribes === 0) this.#attempt = 0;
                this.#set(projectId, 'live');
                this.#ports.onRing(projectId, { ids: [], catchUp: true });
            },
            onSubscriptionRefused: (channel, reason) => {
                const projectId = this.#projectOf(channel);
                if (projectId === null) return;
                this.#ports.onFailure?.(reason);
                this.#set(projectId, 'off');
            },
            onEvent: (frame) => { this.#onEvent(frame); },
            onEnded: (reason) => {
                this.#link = null;
                this.#socketId = null;
                this.#retry(reason);
            },
        });
        this.#link = link;
    }

    #onEvent(frame: PusherFrame): void {
        const projectId = this.#projectOf(frame.channel);
        if (projectId === null) return;
        if (EVENTS.has(frame.event)) this.#ports.onRing(projectId, { ids: ringIds(frame.event, frame.data), catchUp: false });
    }

    #projectOf(channel: string | undefined): string | null {
        if (channel === undefined) return null;
        for (const id of this.#watchers.keys()) if (liveChannel(id) === channel) return id;
        return null;
    }

    async #subscribe(projectId: string): Promise<void> {
        const link = this.#link;
        const socketId = this.#socketId;
        const tynn = this.#ports.tynn();
        if (link === null || socketId === null) return;
        if (tynn === null) { this.#set(projectId, 'off'); return; }
        const channel = liveChannel(projectId);
        link.expectSubscribe(channel);
        try {
            const res = await tynn.request(`/api/v1/projects/${encodeURIComponent(projectId)}${BOARD_LIVE.auth.path}`, { method: 'POST', body: { socket_id: socketId, channel_name: channel } });
            const body = res.ok ? ((await res.json()) as { auth?: unknown }) : null;
            if (!link.active) return;
            if (!this.#watchers.has(projectId)) { link.forget(channel); return; }
            // Tynn will not sign it (404 for every refusal): this board is not live. Not retried in a loop.
            if (!body || typeof body.auth !== 'string' || body.auth === '') {
                link.forget(channel);
                this.#set(projectId, 'off');
                return;
            }
            link.subscribe(channel, body.auth);
        } catch (error) {
            // Tynn could not be reached to sign it: drop and dial again, so it is retried with the rest.
            link.fail(`Tynn could not sign the board's channel: ${(error as Error).message}`);
        }
    }

    #retry(reason: string | null): void {
        if (this.#watchers.size === 0) return;
        if (reason !== null) this.#ports.onFailure?.(reason);
        this.#setAll('reconnecting');
        this.#cancelRetry?.();
        const ms = liveReconnectDelay(this.#attempt);
        this.#attempt += 1;
        this.#cancelRetry = this.#ports.schedule(() => { this.#cancelRetry = null; void this.#connect(); }, ms);
    }
}
