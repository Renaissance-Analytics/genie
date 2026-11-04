/** Notices a change to what a workspace's verdict reads. Skeleton: the tests come first. */

export interface TrustWatchPorts {
    workspaces(): readonly { id: string; path: string }[];
    readText(path: string): Promise<string | null>;
    /** A cheap reading of one file (its size and time), or `null` when it is not there. */
    fingerprint(path: string): Promise<string | null>;
    /** Watch one folder, not its subfolders. The stop, or `null` when it cannot be watched. */
    watchFolder(folder: string, changed: () => void): (() => void) | null;
    refresh(workspaceId: string): void;
    settleMs: number;
}

export class TrustWatch {
    constructor(_ports: TrustWatchPorts) {}
    async pass(): Promise<void> {}
    stop(): void {}
    get watching(): readonly string[] { return []; }
}
