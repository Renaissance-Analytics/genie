import { IssueWatchFeed, parseIssueWatchActivity, parseIssueWatchEntry, type IwEntry, type IwEvent } from '../core/issue-watch.js';
import { encodePong, encodeSubscribe, parsePusherFrame, pusherWsUrl, socketIdOf } from '../core/pusher.js';

/**
 * ISSUEWATCH, LISTENING TO TYNN (Tynn #806). Genie never polls GitHub: Tynn does, with its GitHub App, and pushes each
 * workspace's entry on the person's own private channel (`issuewatch.delta`). Genie reaches it over its Tynn SESSION, on
 * the routes Genie 1 used (main/tynn-account.ts; the owner, 2026-10-19: "everything was already working in genie 1"):
 *
 *   1. `GET  /api/v1/broadcasting-config`             — the public app key and the cluster; the channel is the person's
 *      own, `private-App.Models.User.<id>`, by the id the session answered /api/v1/me with;
 *   2. dial the socket; on `connection_established`, `POST /api/v1/user/broadcasting-auth` signs the channel
 *      for THIS socket, and Genie subscribes;
 *   3. subscribed: `GET /api/v1/user/issue-watch` reconciles every workspace — on EVERY (re)connect, so a delta missed while
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
    /** The Tynn this Genie is signed in to: the person's id, and requests that ride the session; `null` = signed out. */
    readonly tynn: () => SignedInTynn | null;
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

export interface SignedInTynn {
    readonly userId: string;
    request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export type IssueWatchState =
    | { readonly kind: 'signed-out' }
    | { readonly kind: 'connecting' }
    | { readonly kind: 'live' }
    | { readonly kind: 'reconnecting'; readonly reason?: string }
    | { readonly kind: 'stopped' };

/**
 * What a refresh did (Tynn's `POST /api/v1/user/issue-watch/refresh`): Tynn read GitHub now, or refused inside the window every
 * caller of the workspace shares (`reason: 'cooldown'`), or could not (`'failed'` with Tynn's words, `'not-tracked'`);
 * `nextIn` is when the next is allowed. `ok: false` = it never reached Tynn's answer.
 */
export type IssueWatchRefreshAnswer =
    | { readonly ok: true; readonly refreshed: boolean; readonly reason: string; readonly nextIn: string | null; readonly error?: string }
    | { readonly ok: false; readonly reason: string };

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

    /**
     * Ask Tynn to read one project's repos NOW. Its snapshot comes back in the same answer and goes through the feed like
     * a push, so whatever is new is heard as events; a refusal still carries the current snapshot.
     */
    async refresh(projectId: string): Promise<IssueWatchRefreshAnswer> {
        const tynn = this.#ports.tynn();
        if (tynn === null) return { ok: false, reason: 'not signed in to Tynn' };
        let body: { refreshed?: unknown; reason?: unknown; error?: unknown; cooldown?: { label?: unknown }; workspace?: unknown };
        try {
            const res = await tynn.request('/api/v1/user/issue-watch/refresh', { method: 'POST', body: { project_id: projectId } });
            if (!res.ok) return { ok: false, reason: `Tynn answered the refresh with HTTP ${res.status}` };
            body = (await res.json()) as typeof body;
        } catch (error) {
            return { ok: false, reason: `Tynn could not be reached: ${(error as Error).message}` };
        }
        if (body.workspace !== undefined) this.#apply(body.workspace);
        const error = typeof body.error === 'string' && body.error !== '' ? body.error : null;
        return {
            ok: true,
            refreshed: body.refreshed === true,
            reason: typeof body.reason === 'string' ? body.reason : 'unknown',
            nextIn: typeof body.cooldown?.label === 'string' ? body.cooldown.label : null,
            ...(error === null ? {} : { error }),
        };
    }

    #set(state: IssueWatchState): void {
        this.#state = state;
        this.#ports.onState?.(state);
    }

    async #connect(): Promise<void> {
        if (this.#stopped) return;
        const tynn = this.#ports.tynn();
        if (tynn === null) { this.#set({ kind: 'signed-out' }); return; }
        this.#set({ kind: 'connecting' });
        let config: { key?: unknown; cluster?: unknown };
        try {
            const res = await tynn.request('/api/v1/broadcasting-config', { method: 'GET' });
            if (!res.ok) return this.#retry(`Tynn answered the push config with HTTP ${res.status}`);
            config = (await res.json()) as typeof config;
        } catch (error) {
            return this.#retry(`Tynn could not be reached: ${(error as Error).message}`);
        }
        if (typeof config.key !== 'string' || config.key === '') return this.#retry('Tynn has no push configured');
        if (this.#stopped) return;
        // The person's own channel (Tynn's routes/channels.php `App.Models.User.{id}`).
        this.#channel = `private-App.Models.User.${tynn.userId}`;
        const socket = this.#ports.socket(pusherWsUrl(config.key, typeof config.cluster === 'string' && config.cluster !== '' ? config.cluster : 'us2'));
        this.#socket = socket;
        socket.addEventListener('message', (e) => { if (this.#socket === socket) void this.#onFrame(socket, String(e.data), tynn); });
        socket.addEventListener('close', () => { if (this.#socket === socket) this.#onDrop(); });
        socket.addEventListener('error', () => { /* a 'close' follows; the reconnect is scheduled there */ });
    }

    async #onFrame(socket: SocketLike, raw: string, tynn: SignedInTynn): Promise<void> {
        const frame = parsePusherFrame(raw);
        if (!frame) return;
        const socketId = socketIdOf(frame);
        if (socketId !== null) {
            try {
                const res = await tynn.request('/api/v1/user/broadcasting-auth', { method: 'POST', body: { socket_id: socketId, channel_name: this.#channel } });
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
            await this.#reconcile(tynn);
            return;
        }
        if (frame.event === 'issuewatch.delta') {
            // A list too big for one event comes as a notice (tynn.ai#308: counts, `truncated`, no items): pull it whole.
            if ((frame.data as { truncated?: unknown } | null)?.truncated === true) await this.#reconcile(tynn);
            else this.#apply(frame.data);
        }
        // What HAPPENED (Tynn's GitHub webhooks): news, told as it arrives — no feed, no baseline.
        if (frame.event === 'issuewatch.activity') {
            const activity = parseIssueWatchActivity(frame.data);
            if (activity && activity.events.length > 0) this.#ports.onEvents(activity.projectId, activity.events);
        }
    }

    async #reconcile(tynn: SignedInTynn): Promise<void> {
        try {
            const res = await tynn.request('/api/v1/user/issue-watch', { method: 'GET' });
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
