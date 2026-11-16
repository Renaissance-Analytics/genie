import { applyMerge, diffFiles, mergeElements, planSave, type FileStatus, type LiveModel, type MergeDecision, type SavePlan } from '../core/workspace-save.js';
import { withinGitLimit } from './git-ports.js';
import { gitMayRun } from './git-read-policy.js';

/**
 * "SAVE TO REPO" IN MAIN (Tynn #756): the half that touches disk and git.
 *
 * `preview` is read-only apart from one `git fetch`, which it runs FIRST so what it shows as incoming is what the team has
 * now. `save` runs the same pass again (a teammate may have pushed since the preview), refuses on any guard violation or any
 * conflict the person has not settled, and only then writes, each file atomically. It never commits: the save is an ordinary
 * git change in the person's working tree.
 */

export interface SaveFs {
    /** The file's text, or `null` when it does not exist. */
    readText(path: string): Promise<string | null>;
    /** Replace the file whole (temp + rename); the old file stays if this throws. */
    writeTextAtomic(path: string, text: string): Promise<void>;
}

export interface SaveGit {
    fetch(cwd: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The branch this one tracks (`origin/main`), or null. */
    upstream(cwd: string): Promise<string | null>;
    mergeBase(cwd: string, ref: string): Promise<string | null>;
    /** `path` as of `ref`, or null when it is not there. */
    show(cwd: string, ref: string, path: string): Promise<string | null>;
}

export interface SavePreview {
    readonly plan: SavePlan;
    readonly files: readonly { path: string; status: FileStatus }[];
    readonly upstream: { fetched: boolean; ref: string | null; reason?: string };
    /** Every element, and whether it is ours, theirs, the same or a conflict. Empty without an upstream. */
    readonly decisions: readonly MergeDecision[];
    /** The ids of the conflicts the person must settle before a save writes. */
    readonly conflicts: readonly string[];
}

export type SaveResult = { ok: true; written: string[] } | { ok: false; reason: string; written: string[] };

export interface WorkspaceSaveOptions {
    readonly fs: SaveFs;
    readonly git: SaveGit;
    /** The workspace as repo files, or null when it has no project.json. */
    readonly liveModel: (workspacePath: string) => Promise<LiveModel | null>;
    /** A hibernated workspace is a ghost: not read, not fetched. */
    readonly mayReadFolder?: (path: string) => boolean;
    /** The revision this Genie writes; defaults to the planner's. */
    readonly revision?: string;
}

const inFolder = (workspacePath: string, name: string): string => `${workspacePath.replace(/[\\/]+$/, '')}/${name}`;

const refusedPreview = (reason: string): SavePreview => ({ plan: { ok: false, reason, violations: [] }, files: [], upstream: { fetched: false, ref: null }, decisions: [], conflicts: [] });

export class WorkspaceSave {
    readonly #options: WorkspaceSaveOptions;

    constructor(options: WorkspaceSaveOptions) {
        this.#options = options;
    }

    async preview(workspacePath: string): Promise<SavePreview> {
        const { fs, git } = this.#options;
        if (this.#options.mayReadFolder?.(workspacePath) === false) return refusedPreview('this workspace is hibernated; wake it to save');
        const fetched = await git.fetch(workspacePath);
        const ref = await git.upstream(workspacePath);
        const upstream: SavePreview['upstream'] = fetched.ok ? { fetched: true, ref } : { fetched: false, ref, reason: fetched.reason };
        const model = await this.#options.liveModel(workspacePath);
        if (model === null) return { ...refusedPreview('this workspace has no project.json'), upstream };
        const plan = planSave(model, this.#options.revision === undefined ? {} : { revision: this.#options.revision });
        if (!plan.ok) return { plan, files: [], upstream, decisions: [], conflicts: [] };

        const onDisk = new Map<string, string | null>();
        for (const f of plan.files) onDisk.set(f.path, await fs.readText(inFolder(workspacePath, f.path)));
        const files = diffFiles(plan.files, onDisk);

        let decisions: MergeDecision[] = [];
        if (ref !== null) {
            const base = await git.mergeBase(workspacePath, ref);
            const baseTexts = new Map<string, string | null>();
            const incoming = new Map<string, string | null>();
            for (const f of plan.files) {
                baseTexts.set(f.path, base === null ? null : await git.show(workspacePath, base, f.path));
                incoming.set(f.path, await git.show(workspacePath, ref, f.path));
            }
            decisions = mergeElements({ base: baseTexts, local: new Map(plan.files.map((f) => [f.path, f.text])), incoming });
        }
        return { plan, files, upstream, decisions, conflicts: decisions.filter((d) => d.kind === 'conflict').map((d) => d.id) };
    }

    /** `choices` maps a conflict's id to the side the person kept. */
    async save(workspacePath: string, choices: Readonly<Record<string, 'local' | 'incoming'>> = {}): Promise<SaveResult> {
        const preview = await this.preview(workspacePath);
        if (!preview.plan.ok) return { ok: false, reason: preview.plan.reason, written: [] };
        const open = preview.conflicts.filter((id) => choices[id] === undefined);
        if (open.length > 0) return { ok: false, reason: `Settle these conflicts first (yours or theirs): ${open.join(', ')}`, written: [] };

        const texts: { path: string; text: string }[] = [];
        for (const f of preview.plan.files) {
            const merged = applyMerge(f.path, f.text, preview.decisions, choices);
            if (!merged.ok) return { ok: false, reason: `Settle these conflicts first (yours or theirs): ${merged.unresolved.join(', ')}`, written: [] };
            texts.push({ path: f.path, text: merged.text });
        }
        const status = new Map(preview.files.map((f) => [f.path, f.status]));
        const written: string[] = [];
        const out = [...preview.plan.backups, ...texts.filter((t) => status.get(t.path) !== 'unchanged' || t.text !== preview.plan.files.find((f) => f.path === t.path)?.text)];
        for (const file of out) {
            try {
                await this.#options.fs.writeTextAtomic(inFolder(workspacePath, file.path), file.text);
            } catch (error) {
                return { ok: false, reason: `could not write ${file.path}: ${error instanceof Error ? error.message : String(error)}`, written };
            }
            written.push(file.path);
        }
        return { ok: true, written };
    }
}

/** One git command; null when it fails (not a repo, no upstream, no such path). Held to the same trust policy as every other read. */
async function git(cwd: string, args: readonly string[], timeout: number): Promise<{ ok: true; out: string } | { ok: false; reason: string }> {
    if (!(await gitMayRun(cwd))) return { ok: false, reason: 'git may not run in this folder' };
    try {
        return await withinGitLimit((limit) => new Promise<{ ok: true; out: string } | { ok: false; reason: string }>((done) => {
            limit.git(args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
                done(error ? { ok: false, reason: String(stderr || error.message).trim().split('\n')[0] ?? 'git failed' } : { ok: true, out: String(stdout) });
            });
        }));
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** The real git behind {@link SaveGit}. Nothing here commits, merges, resets or checks out. */
export function nodeSaveGit(): SaveGit {
    return {
        async fetch(cwd) {
            const r = await git(cwd, ['fetch', '--quiet'], 60_000);
            return r.ok ? { ok: true } : { ok: false, reason: r.reason };
        },
        async upstream(cwd) {
            const r = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 15_000);
            return r.ok && r.out.trim() !== '' ? r.out.trim() : null;
        },
        async mergeBase(cwd, ref) {
            const r = await git(cwd, ['merge-base', 'HEAD', ref], 15_000);
            return r.ok && r.out.trim() !== '' ? r.out.trim() : null;
        },
        async show(cwd, ref, path) {
            const r = await git(cwd, ['show', `${ref}:${path}`], 15_000);
            return r.ok ? r.out : null;
        },
    };
}
