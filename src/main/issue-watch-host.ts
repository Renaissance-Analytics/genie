import type { BoardLiveSignal } from '../core/tynn-board.js';
import type { IssueWatchSummary, IwEntry, IwEvent, WatchedReposView } from '../core/issue-watch.js';
import type { IssueWatchDelivery, IssueWatchDeliveryPorts } from './issue-watch-delivery.js';
import type { SocketLike } from './issue-watch-client.js';
import type { TynnResponse } from './tynn-account.js';

/**
 * ISSUEWATCH AND THE LIVE BOARD, IN GENIE-HOST (the host split, P5c). P5c RED: the types only; built next.
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

export class IssueWatchService {
    constructor(ports: IssueWatchServicePorts) {
        void ports;
    }

    /** The delivery queue the host's push reads (host-mail-wake.ts). */
    get delivery(): IssueWatchDelivery {
        // P5c red: a queue that never holds anything.
        return { onQueued: () => () => {}, due: () => [], settled: () => {}, wakes: () => false } as unknown as IssueWatchDelivery;
    }

    start(): void {}

    stop(): void {}

    /** Signed in or out, or another Tynn: started over with what is set now. */
    restart(): void {}

    dump(): IssueWatchDump {
        return { state: 'stopped', projects: {} };
    }

    onEvent(listener: (event: IssueWatchHostEvent) => void): () => void {
        void listener;
        return () => {};
    }

    /** A local window's call: `refresh` [workspaceId], `loadRepos` [workspaceId], `setRepo` [workspaceId, owner, repo, change]. */
    call(method: string, args: readonly unknown[]): Promise<unknown> {
        void method; void args;
        return Promise.reject(new Error('P5c red: not built'));
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
    constructor(ports: TynnBoardHubPorts) {
        void ports;
    }

    /** A connection's view follows a workspace's board; false = the workspace is not linked to a Tynn project. */
    watch(owner: string, viewId: string, workspaceId: string): boolean {
        void owner; void viewId; void workspaceId;
        return false;
    }

    unwatch(owner: string, viewId: string): void {
        void owner; void viewId;
    }

    /** The connection closed: every view it held is released. */
    dropOwner(owner: string): void {
        void owner;
    }
}
