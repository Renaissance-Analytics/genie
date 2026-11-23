import type { IssueWatchSummary } from '../core/issue-watch.js';
import { issueWatchSoundSignal, type IssueWatchSoundSignal } from '../core/issue-watch-signal.js';
import type { IssueWatchRefreshAnswer } from './issue-watch-client.js';
import type { IssueWatchDump, IssueWatchHostEvent } from './issue-watch-host.js';
import { issueWatchSummaryOf } from './issue-watch-replica.js';

/**
 * GENIE-HOST'S ISSUEWATCH, FOR ITS OWN TOOLS AND ITS WINDOWS (Tynn #934 task #1474). `checkIssues` and imDone's count line
 * run in genie-host and read its IssueWatch here, with a window open or not: no replica in a window, and nothing of it on
 * the engine link. Which Tynn project a workspace is linked to is genie-host's reading of its project.json.
 */
export interface HostIssueWatchToolPorts {
    /** genie-host's IssueWatchService: its state now, and its calls (`refresh` refuses a workspace linked to no project). */
    readonly issueWatch: { dump(): IssueWatchDump; call(method: string, args: readonly unknown[]): Promise<unknown> };
    /** A workspace's Tynn project (its project.json `tynn.projectId`); null = not linked. */
    readonly projectFor: (workspaceId: string) => string | null;
    /** Ask Tynn again whether this Genie is signed in: genie-host's own account. */
    readonly recheckSignIn: () => void;
}

export interface HostIssueWatchTools {
    forWorkspace(workspaceId: string): IssueWatchSummary;
    refresh(workspaceId: string): Promise<IssueWatchRefreshAnswer>;
    recheckSignIn(): void;
}

export function hostIssueWatchTools(ports: HostIssueWatchToolPorts): HostIssueWatchTools {
    return {
        forWorkspace: (workspaceId) => issueWatchSummaryOf(ports.issueWatch.dump(), ports.projectFor(workspaceId)),
        // A refresh that cannot be made is an answer in words, never a thrown tool.
        refresh: async (workspaceId) => {
            try {
                return (await ports.issueWatch.call('refresh', [workspaceId])) as IssueWatchRefreshAnswer;
            } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) };
            }
        },
        recheckSignIn: () => { ports.recheckSignIn(); },
    };
}

/** Each sound genie-host's IssueWatch says to play now, as a tool signal; a change of state is no sound. */
export function sayIssueWatchSounds(issueWatch: { onEvent(listener: (event: IssueWatchHostEvent) => void): () => void }, say: (signal: IssueWatchSoundSignal) => void): () => void {
    return issueWatch.onEvent((event) => { if (event.kind === 'sound') say(issueWatchSoundSignal(event.sound)); });
}
