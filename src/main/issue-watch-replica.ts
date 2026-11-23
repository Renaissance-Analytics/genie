import { issueWatchPanelView, type IssueWatchPanelView, type IssueWatchSummary } from '../core/issue-watch.js';
import type { IssueWatchDump, IssueWatchHostEvent } from './issue-watch-host.js';

/**
 * GENIE-HOST'S ISSUEWATCH STATE, AS ITS READERS READ IT (the host split, P5c; Tynn #934 task #1474). The state is the
 * service's `IssueWatchDump` (issue-watch-host.ts). genie-host's feature machine keeps the latest one here for the GitHub
 * panel of every workspace, and its tools (`checkIssues`, imDone's count line: issue-watch-tools.ts) read a workspace's
 * summary from the service's dump with `issueWatchSummaryOf`. A window keeps none of it: this was the window's replica
 * until the last reader in a window left.
 *
 * Which Tynn project a workspace is linked to is its project.json's `tynn.projectId`, as for the board.
 */
const STOPPED: IssueWatchDump = { state: 'stopped', projects: {} };

/** What `checkIssues` and imDone's count line read for a project (null = the workspace is not linked). */
export function issueWatchSummaryOf(dump: IssueWatchDump, projectId: string | null): IssueWatchSummary {
    const project = projectId === null ? undefined : dump.projects[projectId];
    return {
        state: dump.state,
        linked: projectId !== null,
        ...(dump.reason !== undefined ? { reason: dump.reason } : {}),
        ...(project?.entry ? { entry: project.entry } : {}),
        ...(project?.deliveredAt !== undefined ? { deliveredAt: project.deliveredAt } : {}),
    };
}

export class IssueWatchReplica {
    #dump: IssueWatchDump = STOPPED;

    /** A dump from the service; a sound is not state (genie-host says it to its windows: issue-watch-tools.ts). */
    apply(event: IssueWatchHostEvent): void {
        if (event.kind === 'sound') return;
        this.#dump = event.dump;
    }

    summaryFor(projectId: string | null): IssueWatchSummary {
        return issueWatchSummaryOf(this.#dump, projectId);
    }

    /** Every workspace's GitHub panel, as the features snapshot carries it. */
    panels(workspaces: ReadonlyArray<{ readonly id: string }>, projectFor: (workspaceId: string) => string | null, now: number): Record<string, IssueWatchPanelView> {
        const out: Record<string, IssueWatchPanelView> = {};
        for (const w of workspaces) {
            const projectId = projectFor(w.id);
            const project = projectId === null ? undefined : this.#dump.projects[projectId];
            out[w.id] = issueWatchPanelView(this.summaryFor(projectId), project?.recent ?? [], now, project?.watched ?? null);
        }
        return out;
    }
}
