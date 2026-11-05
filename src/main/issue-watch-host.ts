import type { BoardLiveSignal } from '../core/tynn-board.js';
import { issueWatchSoundKinds, PANEL_RECENT, type IssueWatchSummary, type IwEntry, type IwEvent, type WatchedReposView } from '../core/issue-watch.js';
import { IssueWatchDelivery, type IssueWatchDeliveryPorts } from './issue-watch-delivery.js';
import { IssueWatchClient, type SocketLike } from './issue-watch-client.js';
import { TynnBoardLive } from './tynn-board-live.js';
import type { TynnResponse } from './tynn-account.js';

/**
 * ISSUEWATCH AND THE LIVE BOARD, IN GENIE-HOST (the host split, P5c). They were built in the window's main, so with no
 * window nobody listened to Tynn: a GitHub change waited for the next window, and no agent was told. The host holds the
 * Tynn account (P3.4), the agents and their one wake (P3.2), so it listens here:
 *
 *  - `IssueWatchService`: the client on the host's account (started at boot, started over when the account changes), the
 *    delivery queue the host's mail wake reads as its second source (host-mail-wake.ts), and the state a LOCAL window's
 *    features read — the latest entry, when it arrived, what happened lately and the repo switches, per Tynn project. A
 *    window asks Refresh, a repo load and a repo switch by call. A batch's sounds are events: an open window plays them,
 *    and with none nothing plays and nothing is kept for later.
 *  - `TynnBoardHub`: one `TynnBoardLive` (one socket for every board) followed per VIEW, as the file watcher is: a
 *    connection's views watch a workspace, its rings and states go to the connections watching it, and a connection that
 *    closes releases its views — the socket closes with the last.
 *
 * Tynn answers every unauthorized call with 404; the client reads that as signed out with the sign-in kept, and so does
 * the host (issue-watch-client.ts, tynn-account.ts). Everything outside is a port: the whole life is tested with a fake
 * Tynn. In the window only on the emergency no-host path (issue-watch-emergency.ts) until P6.
 */

/** The signed-in Tynn the host holds (its TynnAccount): the person's id (null = signed out) and session-bound requests. */
export interface HostTynn {
    userId(): string | null;
    request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<TynnResponse>;
}

/** One Tynn project's IssueWatch, as the host holds it. */
export interface IssueWatchProject {
    readonly entry?: IwEntry;
    /** When its latest entry arrived. */
    readonly deliveredAt?: number;
    /** What happened lately, newest first, capped (PANEL_RECENT). */
    readonly recent: readonly IwEvent[];
    /** Tynn's repo switches for it, once read. */
    readonly watched?: WatchedReposView;
}

/** The host's IssueWatch state, whole: what a local window's features read. */
export interface IssueWatchDump {
    readonly state: IssueWatchSummary['state'];
    readonly reason?: string;
    readonly projects: Readonly<Record<string, IssueWatchProject>>;
}

export type IssueWatchSound = 'ghissue' | 'ghpr' | 'ghsecurity' | 'ghci';

/** What the host tells local windows: the state changed (whole), or a sound to play now (never kept for later). */
export type IssueWatchHostEvent =
    | { readonly kind: 'dump'; readonly dump: IssueWatchDump }
    | { readonly kind: 'sound'; readonly sound: IssueWatchSound };

export interface IssueWatchServicePorts {
    /** The host's Tynn account, once it is open; null = not open yet, or signed out. */
    readonly tynn: () => HostTynn | null;
    readonly socket: (url: string) => SocketLike;
    readonly schedule: (fn: () => void, ms: number) => () => void;
    /** A workspace's Tynn project (its project.json `tynn.projectId`); null = not linked. */
    readonly projectFor: (workspaceId: string) => string | null;
    readonly delivery: IssueWatchDeliveryPorts;
    readonly now?: () => number;
    readonly log?: (line: string) => void;
}

type Change = { enabled?: boolean; includeUpstream?: boolean };

export class IssueWatchService {
    readonly #ports: IssueWatchServicePorts;
    readonly #delivery: IssueWatchDelivery;
    readonly #client: IssueWatchClient;
    #state: IssueWatchSummary['state'] = 'stopped';
    #reason: string | undefined;
    readonly #latest = new Map<string, IwEntry>();
    readonly #delivered = new Map<string, number>();
    readonly #recent = new Map<string, IwEvent[]>();
    readonly #watched = new Map<string, WatchedReposView>();
    readonly #listeners = new Set<(event: IssueWatchHostEvent) => void>();

    constructor(ports: IssueWatchServicePorts) {
        this.#ports = ports;
        this.#delivery = new IssueWatchDelivery(ports.delivery);
        this.#client = new IssueWatchClient({
            // The signed-in Tynn SESSION: the person's id and session-bound requests.
            tynn: () => {
                const account = ports.tynn();
                const userId = account?.userId() ?? null;
                if (!account || userId === null) return null;
                return { userId, request: (path, init) => account.request(path, init) };
            },
            socket: (url) => ports.socket(url),
            schedule: (fn, ms) => ports.schedule(fn, ms),
            onEvents: (projectId, events) => {
                this.#recent.set(projectId, [...[...events].reverse(), ...(this.#recent.get(projectId) ?? [])].slice(0, PANEL_RECENT));
                this.#delivery.onEvents(projectId, events);
                this.#changed();
                // The person's GitHub sound rows (core/alerts.ts): one per kind per batch, for a window open NOW to play.
                for (const sound of issueWatchSoundKinds(events)) this.#emit({ kind: 'sound', sound });
            },
            onEntry: (entry) => {
                this.#latest.set(entry.projectId, entry);
                this.#delivered.set(entry.projectId, this.#now());
                // The project's repo switches, read once when its first entry arrives (then after changes and Refresh).
                if (!this.#watched.has(entry.projectId)) void this.#loadRepos(entry.projectId);
                this.#changed();
            },
            onState: (state) => {
                this.#state = state.kind;
                this.#reason = 'reason' in state ? state.reason : undefined;
                this.#changed();
                ports.log?.(`issuewatch: ${state.kind}${'reason' in state && state.reason ? ` — ${state.reason}` : ''}`);
            },
        });
    }

    /** The delivery queue the host's push reads (host-mail-wake.ts). */
    get delivery(): IssueWatchDelivery {
        return this.#delivery;
    }

    start(): void {
        this.#client.start();
    }

    stop(): void {
        this.#client.stop();
    }

    /** Signed in or out, or another Tynn: started over with what is set now. */
    restart(): void {
        this.#client.stop();
        this.#client.start();
    }

    dump(): IssueWatchDump {
        const projects: Record<string, IssueWatchProject> = {};
        const ids = new Set([...this.#latest.keys(), ...this.#recent.keys(), ...this.#watched.keys()]);
        for (const id of ids) {
            const entry = this.#latest.get(id);
            const deliveredAt = this.#delivered.get(id);
            const watched = this.#watched.get(id);
            projects[id] = {
                ...(entry ? { entry } : {}),
                ...(deliveredAt !== undefined ? { deliveredAt } : {}),
                recent: [...(this.#recent.get(id) ?? [])],
                ...(watched ? { watched } : {}),
            };
        }
        return { state: this.#state, ...(this.#reason !== undefined ? { reason: this.#reason } : {}), projects };
    }

    onEvent(listener: (event: IssueWatchHostEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A local window's call: `refresh` [workspaceId], `loadRepos` [workspaceId], `setRepo` [workspaceId, owner, repo, change]. */
    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        const workspaceId = typeof args[0] === 'string' ? args[0] : '';
        const projectId = workspaceId === '' ? null : this.#ports.projectFor(workspaceId);
        switch (method) {
            case 'refresh': {
                if (projectId === null) return { ok: false, reason: 'this workspace is not linked to a Tynn project' };
                const answer = await this.#client.refresh(projectId);
                void this.#loadRepos(projectId);
                return answer;
            }
            case 'loadRepos':
                if (projectId === null) return { ok: false, reason: 'this workspace is not linked to a Tynn project' };
                await this.#loadRepos(projectId);
                return { ok: true };
            case 'setRepo': {
                if (projectId === null) return { ok: false, reason: 'IssueWatch is not running for this workspace' };
                const owner = typeof args[1] === 'string' ? args[1] : '';
                const repo = typeof args[2] === 'string' ? args[2] : '';
                const raw = (args[3] ?? {}) as { enabled?: unknown; includeUpstream?: unknown };
                const change: Change = {
                    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
                    ...(typeof raw.includeUpstream === 'boolean' ? { includeUpstream: raw.includeUpstream } : {}),
                };
                const r = await this.#client.setWatchedRepo(projectId, owner, repo, change);
                await this.#loadRepos(projectId);
                return r;
            }
            default:
                throw new Error(`IssueWatch has no ${method}`);
        }
    }

    async #loadRepos(projectId: string): Promise<void> {
        const r = await this.#client.watchedRepos(projectId);
        this.#watched.set(projectId, r.ok ? { state: 'ok', ...r.repos } : { state: 'unavailable', reason: r.reason });
        this.#changed();
    }

    #now(): number {
        return this.#ports.now?.() ?? Date.now();
    }

    #changed(): void {
        this.#emit({ kind: 'dump', dump: this.dump() });
    }

    #emit(event: IssueWatchHostEvent): void {
        for (const l of [...this.#listeners]) l(event);
    }
}

/** A board's live signal, for a workspace a connection's view watches. */
export interface TynnBoardHubEvent {
    readonly workspaceId: string;
    readonly signal: BoardLiveSignal;
}

export interface TynnBoardHubPorts {
    readonly tynn: () => HostTynn | null;
    readonly socket: (url: string) => SocketLike;
    readonly schedule: (fn: () => void, ms: number) => () => void;
    readonly projectFor: (workspaceId: string) => string | null;
    /** To the connection (`owner`) whose views watch that workspace. */
    readonly send: (owner: string, event: TynnBoardHubEvent) => void;
    readonly log?: (line: string) => void;
}

export class TynnBoardHub {
    readonly #ports: TynnBoardHubPorts;
    readonly #live: TynnBoardLive;
    /** Each connection's views: viewId → its workspace, project and how to stop following. */
    readonly #views = new Map<string, Map<string, { workspaceId: string; projectId: string; stop: () => void }>>();

    constructor(ports: TynnBoardHubPorts) {
        this.#ports = ports;
        this.#live = new TynnBoardLive({
            tynn: () => {
                const account = ports.tynn();
                if (!account || account.userId() === null) return null;
                return { request: (path, init) => account.request(path, init) };
            },
            socket: (url) => ports.socket(url),
            schedule: (fn, ms) => ports.schedule(fn, ms),
            onRing: (projectId, ring) => { this.#signal(projectId, { ring }); },
            onState: (projectId, state) => { this.#signal(projectId, { state }); },
            onFailure: (reason) => { ports.log?.(`tynn board live: ${reason}`); },
        });
    }

    /** A connection's view follows a workspace's board; false = the workspace is not linked to a Tynn project. */
    watch(owner: string, viewId: string, workspaceId: string): boolean {
        const projectId = this.#ports.projectFor(workspaceId);
        if (projectId === null) return false;
        // The same view watching again (a reconnect sends it again): the old watch goes first.
        this.unwatch(owner, viewId);
        let views = this.#views.get(owner);
        if (!views) { views = new Map(); this.#views.set(owner, views); }
        // Recorded BEFORE the live client is told: it says what it knows of the board at once, to this view too.
        const view = { workspaceId, projectId, stop: () => {} };
        views.set(viewId, view);
        view.stop = this.#live.watch(projectId);
        return true;
    }

    unwatch(owner: string, viewId: string): void {
        const views = this.#views.get(owner);
        const view = views?.get(viewId);
        if (!views || !view) return;
        views.delete(viewId);
        if (views.size === 0) this.#views.delete(owner);
        view.stop();
    }

    /** The connection closed: every view it held is released. */
    dropOwner(owner: string): void {
        const views = this.#views.get(owner);
        if (!views) return;
        this.#views.delete(owner);
        for (const view of views.values()) view.stop();
    }

    /** A project's ring or state: once to each connection, for each workspace of its views on that project. */
    #signal(projectId: string, signal: BoardLiveSignal): void {
        for (const [owner, views] of this.#views) {
            const workspaces = new Set([...views.values()].filter((v) => v.projectId === projectId).map((v) => v.workspaceId));
            for (const workspaceId of workspaces) this.#ports.send(owner, { workspaceId, signal });
        }
    }
}
