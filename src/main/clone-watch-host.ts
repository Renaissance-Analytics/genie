import type { CloneOffer, RepoFile } from '../core/clone-offers.js';
import type { CloneRestorePorts } from './workspace-clone-restore-host.js';

/** Inert stub (RED): the watcher that offers what the repo now says (Tynn #756, PR9c). The implementation lands after the tests are seen failing. */

export interface CloneWatchPorts {
    workspaces(): readonly { id: string; path: string; asleep?: boolean }[];
    readonly restore: CloneRestorePorts;
    /** A cheap stamp of a file (its mtime and size), or null when it is not there. */
    stamp(path: string): Promise<string | null>;
    /** What Genie would save for this workspace now, as the three kinds of file. */
    live(workspace: { id: string; path: string }): Promise<RepoFile[]>;
}

export class CloneWatch {
    constructor(_ports: CloneWatchPorts) {}
    async pass(): Promise<void> {}
    list(_workspaceId: string): CloneOffer[] { return []; }
    onChange(_listener: (workspaceId: string, offers: readonly CloneOffer[]) => void): () => void { return () => {}; }
    async apply(_workspaceId: string, _offerId: string): Promise<{ ok: true } | { ok: false; reason: string }> { return { ok: false, reason: 'not implemented' }; }
}
