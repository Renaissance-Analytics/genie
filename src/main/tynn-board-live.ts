import { encodePong, encodeSubscribe, parsePusherFrame, socketIdOf, socketUrlFor } from '../core/pusher.js';
import { BOARD_LIVE, liveChannel, liveReconnectDelay, ringIds, type LiveState } from '../core/tynn-board.js';
import type { SocketLike } from './issue-watch-client.js';

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
}

const EVENTS: ReadonlySet<string> = new Set(BOARD_LIVE.events);

export class TynnBoardLive {
    readonly #ports: TynnBoardLivePorts;
    /** Open boards: project → how many tabs follow it. */
    readonly #watchers = new Map<string, number>();
    readonly #states = new Map<string, LiveState>();
    #socket: SocketLike | null = null;
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
        if (this.#socket !== null && this.#socketId !== null) {
            if ((this.#watchers.get(projectId) ?? 0) === 1) void this.#subscribe(projectId);
        } else if (this.#socket === null && this.#cancelRetry === null && !this.#dialling) {
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
        const socket = this.#socket;
        this.#socket = null;
        this.#socketId = null;
        try { socket?.close(); } catch { /* already closing */ }
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
            if (!res.ok) { this.#dialling = false; return this.#retry(); }
            url = socketUrlFor((await res.json()) as Parameters<typeof socketUrlFor>[0]);
        } catch {
            this.#dialling = false;
            return this.#retry();
        }
        this.#dialling = false;
        if (this.#watchers.size === 0) return;
        // Tynn has no socket to listen on: the board is simply not live.
        if (url === null) { this.#setAll('off'); return; }
        const socket = this.#ports.socket(url);
        this.#socket = socket;
        socket.addEventListener('message', (e) => { if (this.#socket === socket) void this.#onFrame(socket, String(e.data)); });
        socket.addEventListener('close', () => { if (this.#socket === socket) this.#onDrop(); });
        socket.addEventListener('error', () => { /* a 'close' follows; the reconnect is scheduled there */ });
    }

    async #onFrame(socket: SocketLike, raw: string): Promise<void> {
        const frame = parsePusherFrame(raw);
        if (!frame) return;
        const socketId = socketIdOf(frame);
        if (socketId !== null) {
            this.#socketId = socketId;
            await Promise.all([...this.#watchers.keys()].map((id) => this.#subscribe(id)));
            return;
        }
        if (frame.event === 'pusher:ping') { socket.send(encodePong()); return; }
        const projectId = this.#projectOf(frame.channel);
        if (projectId === null) return;
        if (frame.event === 'pusher_internal:subscription_succeeded') {
            this.#attempt = 0;
            this.#set(projectId, 'live');
            this.#ports.onRing(projectId, { ids: [], catchUp: true });
            return;
        }
        if (frame.event === 'pusher:subscription_error') { this.#set(projectId, 'off'); return; }
        if (EVENTS.has(frame.event)) this.#ports.onRing(projectId, { ids: ringIds(frame.event, frame.data), catchUp: false });
    }

    #projectOf(channel: string | undefined): string | null {
        if (channel === undefined) return null;
        for (const id of this.#watchers.keys()) if (liveChannel(id) === channel) return id;
        return null;
    }

    async #subscribe(projectId: string): Promise<void> {
        const socket = this.#socket;
        const socketId = this.#socketId;
        const tynn = this.#ports.tynn();
        if (socket === null || socketId === null) return;
        if (tynn === null) { this.#set(projectId, 'off'); return; }
        const channel = liveChannel(projectId);
        try {
            const res = await tynn.request(`/api/v1/projects/${encodeURIComponent(projectId)}${BOARD_LIVE.auth.path}`, { method: 'POST', body: { socket_id: socketId, channel_name: channel } });
            const body = res.ok ? ((await res.json()) as { auth?: unknown }) : null;
            if (this.#socket !== socket) return;
            // Tynn will not sign it (404 for every refusal): this board is not live. Not retried in a loop.
            if (!body || typeof body.auth !== 'string' || body.auth === '') { this.#set(projectId, 'off'); return; }
            socket.send(encodeSubscribe(channel, body.auth));
        } catch {
            // Tynn could not be reached to sign it: drop and dial again, so it is retried with the rest.
            if (this.#socket === socket) socket.close();
        }
    }

    #onDrop(): void {
        this.#socket = null;
        this.#socketId = null;
        if (this.#watchers.size === 0) return;
        this.#retry();
    }

    #retry(): void {
        if (this.#watchers.size === 0) return;
        this.#setAll('reconnecting');
        const ms = liveReconnectDelay(this.#attempt);
        this.#attempt += 1;
        this.#cancelRetry = this.#ports.schedule(() => { this.#cancelRetry = null; void this.#connect(); }, ms);
    }
}
