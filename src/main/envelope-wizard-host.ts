import { basename, join } from 'node:path';
import { convertCommitMessage, envelopeRepos, isLocalPathLike, planProblem, type EntryKind, type EnvelopePlan, type SourceAnalysis } from '../core/envelope-plan.js';
import { repoFolderName } from '../core/workspace-model.js';
import { remoteChoiceProblem, type Published, type RemoteChoice } from '../core/agi-remote.js';
import { alreadyNamedReason, envelopeId, makeNewEnvelope, publishNew, registeredEnvFile, stampExisting, type WorkspaceOpsPorts } from './workspace-ops-host.js';

/**
 * BUILDING A NEW `<slug>.agi` AROUND THE PERSON'S REPOS (Add workspace parity item 7) — the main-process half of
 * core/envelope-plan.ts, Genie 1's convertToAgiPlan (create-agi.ts:658-787). Read the source; build the envelope the
 * wizard's plan describes — New's scaffold and first commit (makeNewEnvelope: the ONE envelope writer New and the Tynn
 * import use too), each repo a submodule tracking its branch (the Tynn import's gitAddSubmodule), the manifest's repos[],
 * knowledge COPIED, Genie 1's second commit — then register it. The source is read and cloned FROM; nothing here writes
 * to it. An existing envelope is only registered.
 */

export interface EnvelopePorts {
    /** What the folder is (envelope-fs.ts `analyseFolder`): reads only. */
    analyse(root: string): Promise<SourceAnalysis>;
    /** A file to a file; a directory's contents into a directory, `.git` left out. */
    copy(from: string, to: string, kind: EntryKind): Promise<void>;
    /** `.env` / `.env.*` at the top of `from` into `to` (Genie 1's copyEnvFiles): best effort. */
    copyEnvFiles(from: string, to: string): Promise<void>;
    /** Where an Import from Git clone waits for the wizard. Only a folder it made is ever removed. */
    staging: { make(): Promise<string>; owns(path: string): boolean; remove(path: string): Promise<void> };
}

type Refusal = { ok: false; reason: string };

export type SourceRead =
    /** Already an envelope: registered as it is. From an import, `url` is what to clone where the person chooses. */
    | { ok: true; existing: true; path: string; staged?: true; url?: string }
    | { ok: true; existing: false; analysis: SourceAnalysis; staged: boolean }
    | Refusal;

const isRoot = (path: string) => /^(?:[A-Za-z]:)?[\\/]*$/.test(path.trim());
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Open existing folder: is it an envelope (Genie 1: it has a project.json — register it), or what is in it. */
export async function readSource(ops: WorkspaceOpsPorts, env: EnvelopePorts, path: string): Promise<SourceRead> {
    if (isRoot(path)) return { ok: false, reason: `${path} is a whole drive; pick a folder on it` };
    if (!(await ops.fs.exists(path))) return { ok: false, reason: `${path} does not exist; pick a folder that does` };
    if ((await ops.fs.entries(path)).includes('project.json')) return { ok: true, existing: true, path };
    try {
        return { ok: true, existing: false, analysis: await env.analyse(path), staged: env.staging.owns(path) };
    } catch (error) {
        return { ok: false, reason: message(error) };
    }
}

/**
 * Import from Git: the clone lands in a STAGING folder, not the person's, and goes through the same wizard as a folder
 * (Genie 1 cloned and then analysed, InteractiveUpgradeWizard :427-450). The build adds the repo from its remote and the
 * stage is removed, so nothing is left behind in the person's folders that they did not ask for.
 */
export async function stageFromGit(ops: WorkspaceOpsPorts, env: EnvelopePorts, url: string): Promise<SourceRead> {
    const text = url.trim();
    const name = repoFolderName(text) ?? (isLocalPathLike(text) ? (basename(text.replace(/[\\/]+$/, '')).replace(/\.git$/i, '') || null) : null);
    if (!name) return { ok: false, reason: `"${text}" is not a git URL Genie can clone (https://…/name.git or git@host:owner/name.git)` };
    const stage = await env.staging.make();
    const into = join(stage, name);
    try {
        await ops.fs.gitClone(text, into);
    } catch (error) {
        await env.staging.remove(stage);
        return { ok: false, reason: `git clone failed: ${message(error)}` };
    }
    const read = await readSource(ops, env, into);
    if (read.ok && read.existing) return { ...read, staged: true, url: text };
    if (!read.ok) await env.staging.remove(stage);
    return read;
}

/** An existing envelope: registered, its manifest stamped only when it declares an older schema. Nothing else is written. */
export async function registerExisting(ops: WorkspaceOpsPorts, path: string): Promise<{ ok: true; id: string } | Refusal> {
    if (!(await ops.fs.exists(path)) || !(await ops.fs.entries(path)).includes('project.json')) return { ok: false, reason: `${path} has no project.json; it is not a workspace yet` };
    const id = envelopeId(path);
    if (ops.registry.workspace(id)) return { ok: false, reason: alreadyNamedReason(id) };
    const stamp = await stampExisting(ops, path);
    if (!stamp.ok) return stamp;
    await ops.registry.addWorkspace({ id, path, envFile: registeredEnvFile(ops) });
    return { ok: true, id };
}

/**
 * The wizard's plan, built. Refused before anything is written when the plan cannot be built (planProblem: names, the
 * envelope inside the source, a Root item replacing the envelope's own). A git that refuses part-way leaves the envelope
 * on disk, unregistered, and says which repo and why in git's words.
 */
export async function buildEnvelope(ops: WorkspaceOpsPorts, env: EnvelopePorts, plan: EnvelopePlan, remote?: RemoteChoice): Promise<{ ok: true; id: string; path: string; published?: Published } | Refusal> {
    const problem = planProblem(plan) ?? (remote ? remoteChoiceProblem(remote) : null);
    if (problem) return { ok: false, reason: problem };
    const made = await makeNewEnvelope(ops, plan.name, plan.parent);
    if (!made.ok) return made;
    const ws = made.path;

    const members: Array<{ name: string; url: string; branch: string | null }> = [];
    for (const r of plan.repos) {
        // The branch the clone checked out is recorded in .gitmodules (none for a detached HEAD — never a guessed `main`).
        let branch: string | null;
        try {
            branch = await ops.fs.gitAddSubmodule(ws, r.url, `repos/${r.name}`, null, r.local);
        } catch (error) {
            return { ok: false, reason: `Genie made ${ws}, but could not add ${r.name} from ${r.url}: ${message(error)}` };
        }
        // A local source's clone has only what git tracks; its gitignored .env is restored beside it, still ignored there.
        if (r.local) await env.copyEnvFiles(r.url, join(ws, 'repos', r.name));
        members.push({ name: r.name, url: r.url, branch });
    }
    if (members.length > 0) {
        const current = await ops.fs.readJson(join(ws, 'project.json'));
        const manifest = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
        await ops.fs.writeJson(join(ws, 'project.json'), { ...manifest, ...envelopeRepos(members, plan.primary) });
    }
    for (const k of plan.knowledge) {
        const leaf = basename(k.from.replace(/[\\/]+$/, ''));
        // Genie 1 (create-agi.ts:745-758): a file keeps its name; a directory into `.ai/<subdir>` brings its CONTENTS; a Root directory keeps its name.
        const to = k.to === 'root' ? join(ws, leaf) : k.kind === 'file' ? join(ws, '.ai', k.subdir, leaf) : join(ws, '.ai', k.subdir);
        try {
            await env.copy(k.from, to, k.kind);
        } catch (error) {
            return { ok: false, reason: `Genie made ${ws}, but could not copy ${k.from}: ${message(error)}` };
        }
    }
    const subject = convertCommitMessage(plan.repos.length, plan.knowledge.length);
    if (subject) {
        try {
            await ops.fs.gitCommit(ws, subject);
        } catch (error) {
            return { ok: false, reason: `Genie made ${ws}, but git could not commit the repositories and knowledge: ${message(error)}` };
        }
    }
    await ops.registry.addWorkspace({ id: made.id, path: ws, envFile: registeredEnvFile(ops) });
    if (plan.staged && env.staging.owns(plan.source)) await env.staging.remove(plan.source);
    // Then to the remote chosen on the Workspace step, both commits at once (Add workspace parity item 11).
    const published = await publishNew(ops, ws, remote);
    return published ? { ok: true, id: made.id, path: ws, published } : { ok: true, id: made.id, path: ws };
}

/** The wizard was cancelled on an import: its clone goes. A folder the stage did not make is never touched. */
export async function discardStaged(env: EnvelopePorts, path: string): Promise<{ ok: true }> {
    if (env.staging.owns(path)) await env.staging.remove(path);
    return { ok: true };
}
