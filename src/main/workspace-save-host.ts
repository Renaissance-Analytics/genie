import type { MergeDecision, SaveFile, SavePlan, LiveModel, FileStatus } from '../core/workspace-save.js';

/** Inert stub (RED): "Save to repo" in main (Tynn #756). The implementation lands after the tests are seen failing. */

export interface SaveFs {
    readText(path: string): Promise<string | null>;
    writeTextAtomic(path: string, text: string): Promise<void>;
}

export interface SaveGit {
    fetch(cwd: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    upstream(cwd: string): Promise<string | null>;
    mergeBase(cwd: string, ref: string): Promise<string | null>;
    show(cwd: string, ref: string, path: string): Promise<string | null>;
}

export interface SavePreview {
    readonly plan: SavePlan;
    readonly files: readonly { path: string; status: FileStatus }[];
    readonly upstream: { fetched: boolean; ref: string | null; reason?: string };
    readonly decisions: readonly MergeDecision[];
    readonly conflicts: readonly string[];
}

export type SaveResult = { ok: true; written: string[] } | { ok: false; reason: string; written: string[] };

export interface WorkspaceSaveOptions {
    readonly fs: SaveFs;
    readonly git: SaveGit;
    readonly liveModel: (workspacePath: string) => Promise<LiveModel | null>;
    readonly mayReadFolder?: (path: string) => boolean;
}

export class WorkspaceSave {
    constructor(_options: WorkspaceSaveOptions) {}

    async preview(_workspacePath: string): Promise<SavePreview> {
        return { plan: { ok: true, files: [] as SaveFile[], backups: [], stampedTo: null }, files: [], upstream: { fetched: false, ref: null }, decisions: [], conflicts: [] };
    }

    async save(_workspacePath: string, _choices: Readonly<Record<string, 'local' | 'incoming'>> = {}): Promise<SaveResult> {
        return { ok: true, written: [] };
    }
}
