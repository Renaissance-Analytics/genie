import type { IssueWatchPanelView, IssueWatchSummary } from '../core/issue-watch.js';
import type { IssueWatchRefreshAnswer } from './issue-watch-client.js';
import type { IssueWatchDump, IssueWatchHostEvent, IssueWatchSound } from './issue-watch-host.js';

/**
 * THE WINDOW'S ISSUEWATCH, A REPLICA OF GENIE-HOST'S (the host split, P5c). P5c RED: the types only; built next.
 */
export class IssueWatchReplica {
    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        void call;
    }

    /** A dump or an event from the host. */
    apply(event: IssueWatchHostEvent): void {
        void event;
    }

    dump(): IssueWatchDump {
        return { state: 'stopped', projects: {} };
    }

    /** What `checkIssues` and imDone's count line read for a project (null = the workspace is not linked). */
    summaryFor(projectId: string | null): IssueWatchSummary {
        return { state: 'stopped', linked: projectId !== null };
    }

    /** Every workspace's GitHub panel, as the features snapshot carries it. */
    panels(workspaces: ReadonlyArray<{ readonly id: string }>, projectFor: (workspaceId: string) => string | null, now: number): Record<string, IssueWatchPanelView> {
        void workspaces; void projectFor; void now;
        return {};
    }

    refresh(workspaceId: string): Promise<IssueWatchRefreshAnswer> {
        void workspaceId;
        return Promise.resolve({ ok: false, reason: 'P5c red: not built' });
    }

    setRepo(workspaceId: string, owner: string, repo: string, change: { enabled?: boolean; includeUpstream?: boolean }): Promise<unknown> {
        void workspaceId; void owner; void repo; void change;
        return Promise.resolve({ ok: false, reason: 'P5c red: not built' });
    }

    onChange(listener: (dump: IssueWatchDump) => void): () => void {
        void listener;
        return () => {};
    }

    /** A sound the host says to play now. */
    onSound(listener: (sound: IssueWatchSound) => void): () => void {
        void listener;
        return () => {};
    }
}
