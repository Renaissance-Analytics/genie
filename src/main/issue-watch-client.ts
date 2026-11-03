import { IssueWatchFeed, parseIssueWatchActivity, parseIssueWatchEntry, type IwEntry, type IwEvent, isRepoName, parseWatchedRepos, type WatchedRepos } from '../core/issue-watch.js';
import { encodePong, encodeSubscribe, parsePusherFrame, pusherErrorOf, socketIdOf, socketUrlFor } from '../core/pusher.js';

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
 * THE SOCKET CAN FAIL WITHOUT SAYING SO (genie#1478): production's Reverb refused Genie with `pusher:error` and then left the
 * socket open and silent for 300 s. So a `pusher:error` is a failure with its reason, a dial has a deadline for
 * `connection_established`, and a failed socket is let go at once rather than waited on to close. The same reconcile also
 * runs at start and on each failure, independent of the socket, so a push outage does not blank the list. It is bounded by
 * the backoff, and it is not a poll: once live, nothing asks again until a delta or a drop says to.
 *
 * Everything outside is a port, so the whole life is tested with a fake socket and a fake Tynn.
 */

export interface SocketLike {
    send(data: string): void;
    close(): void;
    addEventListener(type: 'message' | 'close' | 'error', listener: (event: { data?: unknown; message?: unknown }) => void): void;
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
    | { readonly kind: 'connecting'; readonly reason?: string }
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

/** How long a dropped or refused connection first waits before it tries again; it doubles while it keeps failing. */
export const RECONNECT_MS = 5_000;
/** The longest a connection that keeps failing waits between tries. */
export const RECONNECT_MAX_MS = 300_000;
/** How long a dialled socket may say nothing before it counts as failed. */
export const CONNECT_DEADLINE_MS = 15_000;

export class IssueWatchClient {
    readonly #ports: IssueWatchClientPorts;
    readonly #feed = new IssueWatchFeed();
    #state: IssueWatchState = { kind: 'stopped' };
    #stopped = false;
    #socket: SocketLike | null = null;
    #channel: string | null = null;
    #cancelRetry: (() => void) | null = null;
    #cancelDeadline: (() => void) | null = null;
    /** `connection_established` has come on the current socket. */
    #established = false;
    /** What the runtime last said went wrong on the current socket, for the close that follows. */
    #socketError: string | null = null;
    /** How many tries in a row have failed: the next pause. Live starts it over. */
    #failures = 0;
    /** The last failure, said until it is live again, also while it dials the next try. */
    #why: string | null = null;
    /** A pull is out; pulls never overlap, or an older answer could land last and read as things reopening. */
    #pulling = false;
    #pullAgain: SignedInTynn | null = null;
    /** Bumped by stop(): an answer that was out when it stopped is dropped, and a dial that was under way goes no further. */
    #generation = 0;

    constructor(ports: IssueWatchClientPorts) {
        this.#ports = ports;
    }

    state(): IssueWatchState {
        return this.#state;
    }

    start(): void {
        this.#stopped = false;
        this.#failures = 0;
        this.#why = null;
        const tynn = this.#ports.tynn();
        if (tynn !== null) void this.#reconcile(tynn);
        void this.#connect();
    }

    stop(): void {
        this.#stopped = true;
        this.#generation += 1;
        this.#pullAgain = null;
        this.#cancelRetry?.();
        this.#cancelRetry = null;
        this.#endDeadline();
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

    /** Which repos feed this project's stream — Tynn's switches (tynn.ai#307) — or why Tynn would not say. */
    async watchedRepos(projectId: string): Promise<{ ok: true; repos: WatchedRepos } | { ok: false; reason: string }> {
        const tynn = this.#ports.tynn();
        if (tynn === null) return { ok: false, reason: 'not signed in to Tynn' };
        try {
            const res = await tynn.request(`/api/v1/user/issue-watch/${encodeURIComponent(projectId)}/repositories`, { method: 'GET' });
            // Every refusal of Tynn's is a 404, and so is a Tynn without this: said as what it is, not guessed at.
            if (!res.ok) return { ok: false, reason: `Tynn did not answer the repo list (HTTP ${res.status}) — this Tynn may not offer choosing repos yet, or this workspace is not yours to change` };
            const repos = parseWatchedRepos(await res.json());
            return repos ? { ok: true, repos } : { ok: false, reason: 'Tynn answered the repo list with something that is not one' };
        } catch (error) {
            return { ok: false, reason: `Tynn could not be reached: ${(error as Error).message}` };
        }
    }

    /** Set one repo's switch in Tynn; Tynn pushes the changed feed itself. Each switch travels alone. */
    async setWatchedRepo(projectId: string, owner: string, repo: string, change: { enabled?: boolean; includeUpstream?: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (!isRepoName(owner) || !isRepoName(repo)) return { ok: false, reason: `${owner}/${repo} is not a GitHub repo name` };
        const body = { ...(change.enabled !== undefined ? { enabled: change.enabled } : {}), ...(change.includeUpstream !== undefined ? { include_upstream: change.includeUpstream } : {}) };
        if (Object.keys(body).length === 0) return { ok: false, reason: 'nothing to change' };
        const tynn = this.#ports.tynn();
        if (tynn === null) return { ok: false, reason: 'not signed in to Tynn' };
        try {
            const res = await tynn.request(`/api/v1/user/issue-watch/${encodeURIComponent(projectId)}/repositories/${owner}/${repo}`, { method: 'POST', body });
            return res.ok ? { ok: true } : { ok: false, reason: `Tynn did not change ${owner}/${repo} (HTTP ${res.status})` };
        } catch (error) {
            return { ok: false, reason: `Tynn could not be reached: ${(error as Error).message}` };
        }
    }

    #set(state: IssueWatchState): void {
        this.#state = state;
        this.#ports.onState?.(state);
    }

    async #connect(): Promise<void> {
        if (this.#stopped) return;
        const tynn = this.#ports.tynn();
        if (tynn === null) { this.#set({ kind: 'signed-out' }); return; }
        this.#set(this.#why === null ? { kind: 'connecting' } : { kind: 'connecting', reason: this.#why });
        const generation = this.#generation;
        let config: Parameters<typeof socketUrlFor>[0];
        try {
            const res = await tynn.request('/api/v1/broadcasting-config', { method: 'GET' });
            if (generation !== this.#generation) return;
            if (!res.ok) return this.#retry(`Tynn answered the push config with HTTP ${res.status}`);
            config = (await res.json()) as typeof config;
        } catch (error) {
            if (generation !== this.#generation) return;
            return this.#retry(`Tynn could not be reached: ${(error as Error).message}`);
        }
        if (generation !== this.#generation) return;
        const url = socketUrlFor(config);
        if (url === null) return this.#retry('Tynn has no push configured');
        // The person's own channel (Tynn's routes/channels.php `App.Models.User.{id}`).
        this.#channel = `private-App.Models.User.${tynn.userId}`;
        let socket: SocketLike;
        try {
            socket = this.#ports.socket(url);
        } catch (error) {
            return this.#retry(`Tynn's socket could not be dialled: ${(error as Error).message}`);
        }
        this.#socket = socket;
        this.#established = false;
        this.#socketError = null;
        this.#cancelDeadline = this.#ports.schedule(() => {
            this.#fail(socket, `Tynn's socket server said nothing for ${CONNECT_DEADLINE_MS / 1000} s`);
        }, CONNECT_DEADLINE_MS);
        socket.addEventListener('message', (e) => { if (this.#socket === socket) void this.#onFrame(socket, String(e.data), tynn); });
        socket.addEventListener('close', () => { if (this.#socket === socket) this.#onDrop(); });
        // A 'close' follows, and the reconnect is scheduled there; what went wrong is only said here.
        socket.addEventListener('error', (e) => { if (this.#socket === socket && typeof e.message === 'string' && e.message !== '') this.#socketError = e.message; });
    }

    #endDeadline(): void {
        this.#cancelDeadline?.();
        this.#cancelDeadline = null;
    }

    /** This socket has failed: let it go now and try again. Its close may never come, and is ignored if it does. */
    #fail(socket: SocketLike, reason: string): void {
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#endDeadline();
        try { socket.close(); } catch { /* already closing */ }
        this.#retry(reason);
    }

    async #onFrame(socket: SocketLike, raw: string, tynn: SignedInTynn): Promise<void> {
        const frame = parsePusherFrame(raw);
        if (!frame) return;
        const refused = pusherErrorOf(frame);
        if (refused !== null) {
            this.#fail(socket, `Tynn's socket server refused the connection: ${refused.message.slice(0, 200)}${refused.code === null ? '' : ` (${refused.code})`}`);
            return;
        }
        const socketId = socketIdOf(frame);
        if (socketId !== null) {
            this.#established = true;
            this.#endDeadline();
            try {
                const res = await tynn.request('/api/v1/user/broadcasting-auth', { method: 'POST', body: { socket_id: socketId, channel_name: this.#channel } });
                const body = res.ok ? ((await res.json()) as { auth?: unknown }) : null;
                if (this.#socket !== socket) return;
                if (!body || typeof body.auth !== 'string' || body.auth === '') {
                    this.#fail(socket, `Tynn refused to sign the channel: HTTP ${res.status}`);
                    return;
                }
                socket.send(encodeSubscribe(this.#channel!, body.auth));
            } catch (error) {
                this.#fail(socket, `Tynn could not sign the channel: ${(error as Error).message}`);
            }
            return;
        }
        if (frame.event === 'pusher:ping') { socket.send(encodePong()); return; }
        if (frame.channel !== this.#channel) return;
        if (frame.event === 'pusher_internal:subscription_succeeded') {
            this.#failures = 0;
            this.#why = null;
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

    /** Pull the whole list. One at a time: asked for while one is out, it runs again after, so it reads what is true then. */
    async #reconcile(tynn: SignedInTynn): Promise<void> {
        if (this.#pulling) { this.#pullAgain = tynn; return; }
        this.#pulling = true;
        let next: SignedInTynn | null = tynn;
        while (next !== null) {
            this.#pullAgain = null;
            await this.#pull(next);
            next = this.#pullAgain;
        }
        this.#pulling = false;
    }

    async #pull(tynn: SignedInTynn): Promise<void> {
        const generation = this.#generation;
        try {
            const res = await tynn.request('/api/v1/user/issue-watch', { method: 'GET' });
            if (!res.ok) return;
            const body = (await res.json()) as { workspaces?: unknown };
            if (generation !== this.#generation) return;
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
        this.#endDeadline();
        if (this.#stopped) return;
        this.#retry(this.#established ? null : `Tynn's socket closed before it connected${this.#socketError === null ? '' : `: ${this.#socketError}`}`);
    }

    #retry(reason: string | null): void {
        if (this.#stopped) return;
        if (reason !== null) this.#why = reason;
        this.#set(this.#why === null ? { kind: 'reconnecting' } : { kind: 'reconnecting', reason: this.#why });
        this.#cancelRetry?.();
        const pause = Math.min(RECONNECT_MS * 2 ** this.#failures, RECONNECT_MAX_MS);
        this.#failures += 1;
        this.#cancelRetry = this.#ports.schedule(() => { this.#cancelRetry = null; void this.#connect(); }, pause);
        // The list does not wait for the socket: a push outage must not blank it.
        const tynn = this.#ports.tynn();
        if (tynn !== null) void this.#reconcile(tynn);
    }
}
