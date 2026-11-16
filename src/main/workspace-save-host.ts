import { withElements, type ElementSources } from '../core/workspace-elements.js';
import { withPortableSites } from '../core/workspace-sites.js';
import { applyMerge, diffFiles, mergeElements, planSave, type LiveModel, type MergeDecision, type SaveChoices, type SavePreview, type SaveResult } from '../core/workspace-save.js';

export type { SavePreview, SaveResult } from '../core/workspace-save.js';
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
    /** `git fetch`, so what is shown as incoming is what the team has now. Named so it is not mistaken for a network fetch. */
    fetchUpstream(cwd: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The branch this one tracks (`origin/main`), or null. */
    upstream(cwd: string): Promise<string | null>;
    mergeBase(cwd: string, ref: string): Promise<string | null>;
    /** `path` as of `ref`, or null when it is not there. */
    show(cwd: string, ref: string, path: string): Promise<string | null>;
}

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
        const fetched = await git.fetchUpstream(workspacePath);
        const ref = await git.upstream(workspacePath);
        const upstream: SavePreview['upstream'] = fetched.ok ? { fetched: true, ref } : { fetched: false, ref, reason: fetched.reason };
        let model: LiveModel | null;
        try { model = await this.#options.liveModel(workspacePath); } catch (error) { return { ...refusedPreview(error instanceof Error ? error.message : String(error)), upstream }; }
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
    async save(workspacePath: string, choices: SaveChoices = {}): Promise<SaveResult> {
        const preview = await this.preview(workspacePath);
        const plan = preview.plan;
        if (!plan.ok) return { ok: false, reason: plan.reason, written: [] };
        const open = preview.conflicts.filter((id) => choices[id] === undefined);
        if (open.length > 0) return { ok: false, reason: `Settle these conflicts first (yours or theirs): ${open.join(', ')}`, written: [] };

        const texts: { path: string; text: string }[] = [];
        for (const f of plan.files) {
            const merged = applyMerge(f.path, f.text, preview.decisions, choices);
            if (!merged.ok) return { ok: false, reason: `Settle these conflicts first (yours or theirs): ${merged.unresolved.join(', ')}`, written: [] };
            texts.push({ path: f.path, text: merged.text });
        }
        const status = new Map(preview.files.map((f) => [f.path, f.status]));
        const written: string[] = [];
        const out = [...plan.backups, ...texts.filter((t) => status.get(t.path) !== 'unchanged' || t.text !== plan.files.find((f) => f.path === t.path)?.text)];
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
        async fetchUpstream(cwd) {
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

/** The workspace as repo files: today project.json as it is on disk. Each element's own writer adds its files as its PR lands. */
async function liveModelOf(fs: SaveFs, workspacePath: string): Promise<LiveModel | null> {
    const manifestText = await fs.readText(inFolder(workspacePath, 'project.json'));
    if (manifestText === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(manifestText); } catch (error) { throw new Error(`project.json is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it by hand, nothing was changed`); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('project.json is not a JSON object; nothing was changed');
    return { manifest: parsed as Record<string, unknown>, manifestText, files: [] };
}

/** What the dialog sends for its conflicts: only "local" and "incoming" for a string id are kept; nothing else is guessed. */
export function parseSaveChoices(raw: unknown): SaveChoices {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, 'local' | 'incoming'] => entry[1] === 'local' || entry[1] === 'incoming'));
}

/** Save to repo as the bridge calls it: a workspace id in, the preview or the save out. Every refusal is in words. */
export interface WorkspaceSaveOps {
    savePreview(workspaceId: unknown): Promise<SavePreview>;
    save(workspaceId: unknown, choices: unknown): Promise<SaveResult>;
}

const NO_WORKSPACE = 'name a workspace';

/** A host that cannot save (no disk or git wired): it says so. */
export const WORKSPACE_SAVE_UNAVAILABLE: WorkspaceSaveOps = {
    savePreview: async () => refusedPreview('this host cannot save a workspace to its repo'),
    save: async () => ({ ok: false, reason: 'this host cannot save a workspace to its repo', written: [] }),
};

export function workspaceSaveOps(options: {
    fs: SaveFs;
    git: SaveGit;
    pathOf: (workspaceId: string) => string | null;
    mayReadFolder?: (path: string) => boolean;
    revision?: string;
    /** What the workspace holds that a save declares (its services, settings and agents' IssueWatch). Absent: project.json as it is. */
    elements?: (workspaceId: string) => ElementSources | Promise<ElementSources>;
}): WorkspaceSaveOps {
    /** The saver for one workspace: its live model is project.json with that workspace's declarations in it. */
    const saverFor = (workspaceId: string) => new WorkspaceSave({
        fs: options.fs,
        git: options.git,
        // Sites save portably (Tynn #756, PR4): paths relative to the folder they run in, ports as the placeholder.
        liveModel: async (path) => {
            const loaded = await liveModelOf(options.fs, path);
            if (loaded === null) return null;
            const model = withPortableSites(loaded, path);
            if (!options.elements) return model;
            return withElements(model, await options.elements(workspaceId), workspaceId, path).model;
        },
        ...(options.mayReadFolder ? { mayReadFolder: options.mayReadFolder } : {}),
        ...(options.revision ? { revision: options.revision } : {}),
    });
    const pathOf = (id: unknown): string | null => (typeof id === 'string' ? options.pathOf(id) : null);
    return {
        async savePreview(id) {
            const path = pathOf(id);
            return path === null ? refusedPreview(NO_WORKSPACE) : saverFor(id as string).preview(path);
        },
        async save(id, choices) {
            const path = pathOf(id);
            return path === null ? { ok: false, reason: NO_WORKSPACE, written: [] } : saverFor(id as string).save(path, parseSaveChoices(choices));
        },
    };
}
