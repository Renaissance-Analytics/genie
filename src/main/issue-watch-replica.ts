import { issueWatchPanelView, type IssueWatchPanelView, type IssueWatchSummary } from '../core/issue-watch.js';
import type { IssueWatchRefreshAnswer } from './issue-watch-client.js';
import type { IssueWatchDump, IssueWatchHostEvent, IssueWatchSound } from './issue-watch-host.js';

/**
 * THE WINDOW'S ISSUEWATCH, A REPLICA OF GENIE-HOST'S (the host split, P5c). The state is the host's `IssueWatchDump`, sent
 * whole on the window's LOCAL link (`issueWatch.dump` before ready, `issueWatch.event` on every change); the GitHub panel,
 * `checkIssues` and imDone's count line read it as they read main's own maps before. Refresh and the repo switches go to
 * the host as calls. A sound the host says to play is played by the window open now; nothing here keeps one for later.
 *
 * Which Tynn project a workspace is linked to stays the window's reading of its project.json, as for the board.
 */
const STOPPED: IssueWatchDump = { state: 'stopped', projects: {} };

export class IssueWatchReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    #dump: IssueWatchDump = STOPPED;
    readonly #listeners = new Set<(dump: IssueWatchDump) => void>();
    readonly #sounds = new Set<(sound: IssueWatchSound) => void>();

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    /** A dump or an event from the host. */
    apply(event: IssueWatchHostEvent): void {
        if (event.kind === 'sound') {
            for (const l of [...this.#sounds]) l(event.sound);
            return;
        }
        this.#dump = event.dump;
        for (const l of [...this.#listeners]) l(event.dump);
    }

    dump(): IssueWatchDump {
        return this.#dump;
    }

    /** What `checkIssues` and imDone's count line read for a project (null = the workspace is not linked). */
    summaryFor(projectId: string | null): IssueWatchSummary {
        const d = this.#dump;
        const project = projectId === null ? undefined : d.projects[projectId];
        return {
            state: d.state,
            linked: projectId !== null,
            ...(d.reason !== undefined ? { reason: d.reason } : {}),
            ...(project?.entry ? { entry: project.entry } : {}),
            ...(project?.deliveredAt !== undefined ? { deliveredAt: project.deliveredAt } : {}),
        };
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

    async refresh(workspaceId: string): Promise<IssueWatchRefreshAnswer> {
        try {
            return (await this.#call('refresh', [workspaceId])) as IssueWatchRefreshAnswer;
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    async setRepo(workspaceId: string, owner: string, repo: string, change: { enabled?: boolean; includeUpstream?: boolean }): Promise<unknown> {
        try {
            return await this.#call('setRepo', [workspaceId, owner, repo, change]);
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    onChange(listener: (dump: IssueWatchDump) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A sound the host says to play now. */
    onSound(listener: (sound: IssueWatchSound) => void): () => void {
        this.#sounds.add(listener);
        return () => { this.#sounds.delete(listener); };
    }
}
