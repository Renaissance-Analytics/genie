import { IssueWatchFeed, parseIssueWatchActivity, parseIssueWatchEntry, type IwEntry, type IwEvent } from '../core/issue-watch.js';
import { encodePong, encodeSubscribe, parsePusherFrame, pusherWsUrl, socketIdOf } from '../core/pusher.js';

/**
 * ISSUEWATCH, LISTENING TO TYNN (Tynn #806). Genie never polls GitHub: Tynn does, with its GitHub App, and pushes each
 * workspace's entry on the person's own private channel (`issuewatch.delta`). Genie reaches it with the Tynn token it
 * ALREADY holds (the owner, 2026-10-17: no new token to mint):
 *
 *   1. `GET  /api/v1/issue-watch/push-config`        — the public app key, the cluster, the person's channel;
 *   2. dial the socket; on `connection_established`, `POST /api/v1/issue-watch/broadcasting-auth` signs the channel
 *      for THIS socket, and Genie subscribes;
 *   3. subscribed: `GET /api/v1/issue-watch` reconciles every workspace — on EVERY (re)connect, so a delta missed while
 *      the socket was down is never lost;
 *   4. each entry, reconciled or pushed, goes through one IssueWatchFeed: the first after a boot is a baseline, after
 *      that what changed comes out as events.
 *
 * A drop reconnects after a pause; nothing polls. Everything outside is a port, so the whole life is tested with a fake
 * socket and a fake Tynn.
 */

export interface SocketLike {
    send(data: string): void;
    close(): void;
    addEventListener(type: 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export interface IssueWatchClientPorts {
    /** The Tynn this Genie is signed in to, and its token; `null` = not signed in. */
    readonly credentials: () => { host: string; token: string } | null;
    readonly fetch: (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
    readonly socket: (url: string) => SocketLike;
    /** Run `fn` after `ms`; answers a cancel. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
    /** What changed in one Tynn project (a Genie workspace's `tynn.projectId`). */
    readonly onEvents: (projectId: string, events: IwEvent[]) => void;
    /** Each state, as it changes (the panel's line). */
    readonly onState?: (state: IssueWatchState) => void;
    /** Every entry Tynn sent, reconciled or pushed — the latest is what `checkIssues` and imDone's count line read. */
    readonly onEntry?: (entry: IwEntry) => void;
}

export type IssueWatchState =
    | { readonly kind: 'signed-out' }
    | { readonly kind: 'connecting' }
    | { readonly kind: 'live' }
    | { readonly kind: 'reconnecting'; readonly reason?: string }
    | { readonly kind: 'stopped' };

/** How long a dropped or refused connection waits before it tries again. */
export const RECONNECT_MS = 5_000;

export class IssueWatchClient {
    readonly #ports: IssueWatchClientPorts;
    readonly #feed = new IssueWatchFeed();
    #state: IssueWatchState = { kind: 'stopped' };
    #stopped = false;
    #socket: SocketLike | null = null;
    #channel: string | null = null;
    #cancelRetry: (() => void) | null = null;
    /** Why the current socket is being closed, said on the reconnecting state that follows. */
    #closing: string | null = null;

    constructor(ports: IssueWatchClientPorts) {
        this.#ports = ports;
    }

    state(): IssueWatchState {
        return this.#state;
    }

    start(): void {
        this.#stopped = false;
        void this.#connect();
    }

    stop(): void {
        this.#stopped = true;
        this.#cancelRetry?.();
        this.#cancelRetry = null;
        const socket = this.#socket;
        this.#socket = null;
        this.#set({ kind: 'stopped' });
        try { socket?.close(); } catch { /* already closing */ }
    }

    #set(state: IssueWatchState): void {
        this.#state = state;
        this.#ports.onState?.(state);
    }

    #headers(token: string): Record<string, string> {
        return { authorization: `Bearer ${token}`, accept: 'application/json' };
    }

    async #connect(): Promise<void> {
        if (this.#stopped) return;
        const creds = this.#ports.credentials();
        if (creds === null) { this.#set({ kind: 'signed-out' }); return; }
        this.#set({ kind: 'connecting' });
        const base = creds.host.replace(/\/+$/, '');
        let config: { key?: unknown; cluster?: unknown; channel?: unknown };
        try {
            const res = await this.#ports.fetch(`${base}/api/v1/issue-watch/push-config`, { method: 'GET', headers: this.#headers(creds.token) });
            if (!res.ok) return this.#retry(`Tynn answered the push config with HTTP ${res.status}`);
            config = (await res.json()) as typeof config;
        } catch (error) {
            return this.#retry(`Tynn could not be reached: ${(error as Error).message}`);
        }
        if (typeof config.key !== 'string' || config.key === '' || typeof config.channel !== 'string' || config.channel === '') {
            return this.#retry('Tynn has no push configured');
        }
        if (this.#stopped) return;
        this.#channel = config.channel;
        const socket = this.#ports.socket(pusherWsUrl(config.key, typeof config.cluster === 'string' && config.cluster !== '' ? config.cluster : 'us2'));
        this.#socket = socket;
        socket.addEventListener('message', (e) => { if (this.#socket === socket) void this.#onFrame(socket, String(e.data), base, creds.token); });
        socket.addEventListener('close', () => { if (this.#socket === socket) this.#onDrop(); });
        socket.addEventListener('error', () => { /* a 'close' follows; the reconnect is scheduled there */ });
    }

    async #onFrame(socket: SocketLike, raw: string, base: string, token: string): Promise<void> {
        const frame = parsePusherFrame(raw);
        if (!frame) return;
        const socketId = socketIdOf(frame);
        if (socketId !== null) {
            try {
                const res = await this.#ports.fetch(`${base}/api/v1/issue-watch/broadcasting-auth`, {
                    method: 'POST',
                    headers: { ...this.#headers(token), 'content-type': 'application/json' },
                    body: JSON.stringify({ socket_id: socketId, channel_name: this.#channel }),
                });
                const body = res.ok ? ((await res.json()) as { auth?: unknown }) : null;
                if (!body || typeof body.auth !== 'string' || body.auth === '') {
                    this.#closing = `Tynn refused to sign the channel: HTTP ${res.status}`;
                    socket.close();
                    return;
                }
                socket.send(encodeSubscribe(this.#channel!, body.auth));
            } catch (error) {
                this.#closing = `Tynn could not sign the channel: ${(error as Error).message}`;
                socket.close();
            }
            return;
        }
        if (frame.event === 'pusher:ping') { socket.send(encodePong()); return; }
        if (frame.channel !== this.#channel) return;
        if (frame.event === 'pusher_internal:subscription_succeeded') {
            this.#set({ kind: 'live' });
            await this.#reconcile(base, token);
            return;
        }
        if (frame.event === 'issuewatch.delta') this.#apply(frame.data);
        // What HAPPENED (Tynn's GitHub webhooks): news, told as it arrives — no feed, no baseline.
        if (frame.event === 'issuewatch.activity') {
            const activity = parseIssueWatchActivity(frame.data);
            if (activity && activity.events.length > 0) this.#ports.onEvents(activity.projectId, activity.events);
        }
    }

    async #reconcile(base: string, token: string): Promise<void> {
        try {
            const res = await this.#ports.fetch(`${base}/api/v1/issue-watch`, { method: 'GET', headers: this.#headers(token) });
            if (!res.ok) return;
            const body = (await res.json()) as { workspaces?: unknown };
            for (const raw of Array.isArray(body.workspaces) ? body.workspaces : []) this.#apply(raw);
        } catch {
            // The next delta or reconnect brings it: the feed is never left half-applied, only not yet updated.
        }
    }

    #apply(raw: unknown): void {
        const entry = parseIssueWatchEntry(raw);
        if (!entry) return;
        this.#ports.onEntry?.(entry);
        const events = this.#feed.apply(entry);
        if (events.length > 0) this.#ports.onEvents(entry.projectId, events);
    }

    #onDrop(): void {
        this.#socket = null;
        if (this.#stopped) return;
        const reason = this.#closing;
        this.#closing = null;
        this.#retry(reason);
    }

    #retry(reason: string | null): void {
        if (this.#stopped) return;
        this.#set(reason === null ? { kind: 'reconnecting' } : { kind: 'reconnecting', reason });
        this.#cancelRetry?.();
        this.#cancelRetry = this.#ports.schedule(() => { this.#cancelRetry = null; void this.#connect(); }, RECONNECT_MS);
    }
}
