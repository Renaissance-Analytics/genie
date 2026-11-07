import { TYNN_HOST } from '../core/tynn.js';
import type { IssueWatchDeliveryPorts } from './issue-watch-delivery.js';
import { IssueWatchService, TynnBoardHub, type HostTynn, type TynnBoardHubEvent } from './issue-watch-host.js';
import { wireIssueWatchPush } from './issue-watch-push.js';
import type { InboxPushPorts } from './inbox-push.js';
import { dialTynnSocket } from './tynn-socket.js';
import { TYNN_ISSUES_FEED } from './tynn-issues-live.js';

/**
 * ISSUEWATCH AND THE LIVE BOARD IN THE WINDOW — THE EMERGENCY NO-HOST PATH ONLY (the host split, P5c; §4.1). genie-host
 * runs them (issue-watch-host.ts). When no host could start, the window runs its own engine, its own Tynn account and its
 * own agents, and this runs the same service and board hub against them, so IssueWatch keeps working as it did. main loads
 * it lazily (`import()`) only on that path, so the window's static graph holds no IssueWatch, board or Pusher socket.
 * P6 removes the path, and this with it.
 */
export interface WindowIssueWatch {
    readonly issueWatch: IssueWatchService;
    readonly board: { watch(viewId: string, workspaceId: string): boolean; unwatch(viewId: string): void };
    readonly issues: { watch(viewId: string, workspaceId: string): boolean; unwatch(viewId: string): void };
    stop(): void;
}

const WINDOW = 'window';

export function startWindowIssueWatch(p: {
    /** The window's own Tynn account (the emergency path opens one). */
    readonly account: () => (HostTynn & { host(): string; onChange(listener: () => void): () => void }) | null;
    readonly projectFor: (workspaceId: string) => string | null;
    readonly delivery: IssueWatchDeliveryPorts;
    /** The window's own sessions, and its wake (main's `wakeAgent`). */
    readonly host: InboxPushPorts['host'];
    readonly wake: (agentId: string) => boolean | Promise<boolean>;
    readonly onBoard: (event: TynnBoardHubEvent) => void;
    readonly onIssues?: (event: TynnBoardHubEvent) => void;
    readonly log: (line: string) => void;
}): WindowIssueWatch {
    const socket = (url: string) => dialTynnSocket(url, p.account()?.host() ?? TYNN_HOST);
    const schedule = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
    const issueWatch = new IssueWatchService({ tynn: () => p.account(), socket, schedule, projectFor: p.projectFor, delivery: p.delivery, log: p.log });
    const offPush = wireIssueWatchPush({ delivery: issueWatch.delivery, host: p.host, wake: p.wake });
    const hub = new TynnBoardHub({ tynn: () => p.account(), socket, schedule, projectFor: p.projectFor, send: (_owner, event) => { p.onBoard(event); }, log: p.log });
    const issues = new TynnBoardHub({ tynn: () => p.account(), socket, schedule, projectFor: p.projectFor, feed: TYNN_ISSUES_FEED, send: (_owner, event) => { p.onIssues?.(event); }, log: p.log });
    issueWatch.start();
    // Signing in or out of Tynn, or pointing at another one, starts it over with what is set now.
    const offAccount = p.account()?.onChange(() => { issueWatch.restart(); }) ?? (() => {});
    return {
        issueWatch,
        board: { watch: (viewId, workspaceId) => hub.watch(WINDOW, viewId, workspaceId), unwatch: (viewId) => { hub.unwatch(WINDOW, viewId); } },
        issues: { watch: (viewId, workspaceId) => issues.watch(WINDOW, viewId, workspaceId), unwatch: (viewId) => { issues.unwatch(WINDOW, viewId); } },
        stop: () => { offAccount(); offPush(); issueWatch.stop(); hub.dropOwner(WINDOW); issues.dropOwner(WINDOW); },
    };
}
