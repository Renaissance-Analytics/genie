import { basename, join } from 'node:path';
import type { AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import { classifyFolder, gitAddPlan, hibernate, planAdd, repoFolderName, stampSchema, SCHEMA_REVISION, type FolderKind, type GitAddPlan, type PlanStep } from '../core/workspace-model.js';
import { ENVELOPE_DIRS, ENVELOPE_GITIGNORE, envelopeReadme, envelopeRules, firstCommitMessage, newWorkspaceProblem, workspaceFolderName } from '../core/add-workspace.js';
import { writeAgentGitignore } from './agent-gitignore.js';
import { routerText } from './agent-routers.js';
import { DEFAULT_ENV_FILE, envFileName } from '../core/dotenv.js';
import { parseTynnProject, tynnAddPlan, tynnEnvelopePath, type TynnAddPlan, type TynnLink, type TynnProject } from '../core/tynn.js';
import { addRepo } from '../core/repo-registry.js';
import { remoteChoiceProblem, type Published, type RemoteChoice } from '../core/agi-remote.js';
import { publishEnvelope, type AgiRemotePorts } from './agi-remote-host.js';

/**
 * WORKSPACE OPERATIONS IN THE APP (§6.1) — the main-process half over core/workspace-model.
 *
 * Adding a folder is PREVIEWED (classified; the plan shown) before anything is written, and the write
 * produces a real envelope manifest — the published shared-schemas URL — refusing to touch a manifest
 * that declares a newer schema. Hibernate asks every running agent for a handoff with a bounded wait,
 * marks the workspace asleep (nothing may start in it; the flag is on disk so it stays asleep through
 * restarts and upgrades), then stops agents, terminals and processes. Remove forgets the workspace and
 * its agents and NEVER touches the folder. Every port is injected; main.ts passes the real ones.
 */

export interface WorkspaceOpsPorts {
    fs: {
        exists(path: string): Promise<boolean>;
        entries(path: string): Promise<string[]>;
        readJson(path: string): Promise<unknown | null>;
        writeJson(path: string, value: unknown): Promise<void>;
        mkdir(path: string): Promise<void>;
        writeText(path: string, text: string): Promise<void>;
        gitInit(path: string): Promise<void>;
        /** `git init` on `main`, everything staged, one commit (git-ports.ts); rejects with git's own words. */
        gitFirstCommit(path: string, message: string): Promise<void>;
        /** Everything in the folder staged, one commit (git-ports.ts gitCommit); rejects with git's own words. */
        gitCommit(path: string, message: string): Promise<void>;
        /** `git clone --recurse-submodules [--branch <branch>] <url> <into>`; rejects with git's own words. */
        gitClone(url: string, into: string, branch?: string | null): Promise<void>;
        /**
         * `git submodule add [-b <branch>] <url> <at>` in an envelope (git-ports.ts); resolves to the branch tracked. `local`:
         * the source is a folder on disk (the envelope wizard's Local), which git clones only with protocol.file.allow.
         */
        gitAddSubmodule(envelope: string, url: string, at: string, branch: string | null, local?: boolean): Promise<string | null>;
    };
    registry: {
        workspace(id: string): { id: string; path: string; asleep: boolean } | null;
        /** Every registered workspace (the Tynn import's "already added" reads their project.json `tynn.projectId`). */
        list(): readonly { id: string; path: string }[];
        addWorkspace(record: { id: string; path: string; envFile?: string }): Promise<void>;
        agentsOf(workspaceId: string): readonly AgentRecord[];
        setAsleep(workspaceId: string, asleep: boolean): Promise<boolean>;
        forgetWorkspace(workspaceId: string): Promise<{ agentsForgotten: number } | null>;
    };
    host: {
        probe(agentId: AgentRecord['id']): LiveSession | null;
        prompt(agentId: AgentRecord['id'], text: string): boolean;
        stop(agentId: AgentRecord['id']): boolean;
    };
    attention: { finished(): readonly { agentId: string; handoff: string | null; at: string }[] };
    terminals: { list(): readonly { id: string; workspaceId: string }[]; close(id: string): boolean };
    supervisor: { list(): readonly { id: string; workspaceId: string }[]; stop(id: string): boolean };
    now(): number;
    sleep(ms: number): Promise<void>;
    /** Tynn (§6.1 add from Tynn): the host, and the signed-in person's projects (main/tynn-account.ts); absent on a host without it. */
    tynn?: { readonly host: string; projects(): Promise<unknown[]> } | undefined;
    /** Settings → General "Env file name" (`default_env_file`), read at each add; absent = `.env`. */
    defaultEnvFile?: (() => string) | undefined;
    /** Where a new envelope goes once it is made (agi-remote-host.ts): GitHub, a pasted remote, Tynn. Absent = nowhere. */
    remote?: AgiRemotePorts | undefined;
}

/**
 * The env file a workspace is registered with (Add workspace parity 2b; Genie 1's add-workspace.ts:185 stamped
 * `default_env_file` as `env_file`): the setting as it is NOW, or `.env` when it is blank or not a file name.
 */
export function registeredEnvFile(ports: Pick<WorkspaceOpsPorts, 'defaultEnvFile'>): string {
    return envFileName(ports.defaultEnvFile?.()) ?? DEFAULT_ENV_FILE;
}

type Refusal = { ok: false; reason: string };

export type AddPreview = { ok: true; path: string; kind: FolderKind; steps: PlanStep[] } | Refusal;

/** A workspace's id is its folder's name; two of one name were scaffolded, then the second silently not registered. */
const alreadyNamed = (id: string) => `There is already a workspace named ${id}. Rename the folder, or open that workspace instead.`;

/** The root of a drive or of the filesystem: a plain folder now, and never a workspace. */
const isRoot = (path: string) => /^(?:[A-Za-z]:)?[\\/]*$/.test(path.trim());

export async function previewAddWorkspace(ports: WorkspaceOpsPorts, path: string, id: string = basename(path)): Promise<AddPreview> {
    if (isRoot(path)) return { ok: false, reason: `${path} is a whole drive; pick a folder on it` };
    if (ports.registry.workspace(id)) return { ok: false, reason: alreadyNamed(id) };
    const exists = await ports.fs.exists(path);
    const kind = classifyFolder({ exists, entries: exists ? await ports.fs.entries(path) : [] });
    try {
        return { ok: true, path, kind, steps: planAdd(kind, path) };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

const SCHEMA_URL = `https://raw.githubusercontent.com/Civicognita/shared-schemas/v${SCHEMA_REVISION}/schemas/workspace/project.schema.json`;

function freshManifest(path: string, kind: FolderKind): Record<string, unknown> {
    const name = basename(path);
    return {
        $schema: SCHEMA_URL,
        name,
        createdAt: new Date().toISOString().slice(0, 10),
        type: 'agi',
        description: '',
        // A simple repo IS the host repo: the envelope wraps this folder rather than a repos/ child.
        repos: kind === 'simple-repo' ? [{ name, slug: name, path: '.', role: 'app' }] : [],
    };
}

/**
 * An existing envelope's manifest, stamped with this Genie's schema ONLY when it declares an older one (a backup kept);
 * a current one is not written at all, and a newer one is refused untouched.
 */
export async function stampExisting(ports: WorkspaceOpsPorts, path: string): Promise<{ ok: true; stamped: { from: string | null; backup: string } | null } | Refusal> {
    const manifestPath = join(path, 'project.json');
    const current = await ports.fs.readJson(manifestPath);
    const manifest = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
    const stamp = stampSchema(manifest, SCHEMA_REVISION);
    if (!stamp.ok) return stamp;
    if (!stamp.backup) return { ok: true, stamped: null };
    await ports.fs.writeJson(join(path, stamp.backup), manifest);
    await ports.fs.writeJson(manifestPath, stamp.manifest);
    return { ok: true, stamped: { from: stamp.from, backup: stamp.backup } };
}

/** An existing envelope's id, as New's and Tynn's are: its folder without `.agi`. */
export const envelopeId = (path: string): string => basename(path.replace(/[\\/]+$/, '')).replace(/\.agi$/i, '');

/** The refusal for a second workspace of one name (see `alreadyNamed`). */
export const alreadyNamedReason = (id: string): string => alreadyNamed(id);

export async function addWorkspace(ports: WorkspaceOpsPorts, path: string, overlay?: Record<string, unknown>, id: string = basename(path)): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | Refusal> {
    const preview = await previewAddWorkspace(ports, path, id);
    if (!preview.ok) return preview;
    const manifestPath = join(path, 'project.json');
    let stamped: { from: string | null; backup: string } | null = null;

    if (preview.kind === 'full-envelope') {
        const stamp = await stampExisting(ports, path);
        if (!stamp.ok) return stamp;
        stamped = stamp.stamped;
    } else {
        if (preview.kind === 'empty') await ports.fs.mkdir(join(path, 'repos'));
        await ports.fs.mkdir(join(path, '.ai'));
        await ports.fs.mkdir(join(path, 'sandbox'));
        await ports.fs.mkdir(join(path, '.trash'));
        // The source may say more than the folder does (§6.1 from Tynn: the project name, its vision, the `tynn` link).
        await ports.fs.writeJson(manifestPath, { ...freshManifest(path, preview.kind), ...(overlay ?? {}) });
        if (preview.kind === 'empty') await ports.fs.gitInit(path);
    }

    // The id the preview checked is free (see `alreadyNamed`).

    await ports.registry.addWorkspace({ id, path, envFile: registeredEnvFile(ports) });
    return { ok: true, id, kind: preview.kind, stamped };
}

const HANDOFF_ASK = (workspaceId: string) => `Genie is hibernating ${workspaceId}: call imDone with a handoff now — what you were doing, what is unfinished, what the next run picks up. You will be stopped shortly.`;

export async function hibernateWorkspace(ports: WorkspaceOpsPorts, workspaceId: string, options: { handoffWaitMs: number; pollMs: number }): Promise<{ ok: true; asleep: true; handoffs: { landed: string[]; missing: string[] } } | Refusal> {
    const workspace = ports.registry.workspace(workspaceId);
    if (!workspace) return { ok: false, reason: `no workspace ${workspaceId}` };
    const running = ports.registry.agentsOf(workspaceId).filter((a) => ports.host.probe(a.id)?.running === true).map((a) => a.id as string);
    const terminals = ports.terminals.list().filter((t) => t.workspaceId === workspaceId).map((t) => t.id);
    const processes = ports.supervisor.list().filter((p) => p.workspaceId === workspaceId).map((p) => p.id);
    const plan = hibernate({ workspaceId, agents: running, terminals, processes, handoffWaitMs: options.handoffWaitMs });

    const landed = new Set<string>();
    for (const step of plan.steps) {
        switch (step.kind) {
            case 'ask-handoff': {
                const since = ports.now();
                for (const id of step.agents) ports.host.prompt(id as AgentRecord['id'], HANDOFF_ASK(workspaceId));
                const deadline = since + step.waitMs;
                while (ports.now() < deadline && landed.size < step.agents.length) {
                    await ports.sleep(options.pollMs);
                    for (const f of ports.attention.finished()) {
                        if (step.agents.includes(f.agentId) && f.handoff !== null && Date.parse(f.at) >= since) landed.add(f.agentId);
                    }
                }
                break;
            }
            case 'mark-asleep':
                await ports.registry.setAsleep(workspaceId, true);
                break;
            case 'stop-agents':
                for (const id of step.agents) ports.host.stop(id as AgentRecord['id']);
                break;
            case 'stop-terminals':
                for (const id of step.terminals) ports.terminals.close(id);
                break;
            case 'stop-processes':
                for (const id of step.processes) ports.supervisor.stop(id);
                break;
            case 'leave-inbox':
                // Stopped agents are no longer reachable; the inbox store's receive path answers that itself.
                break;
        }
    }
    return { ok: true, asleep: true, handoffs: { landed: running.filter((id) => landed.has(id)), missing: running.filter((id) => !landed.has(id)) } };
}

export async function wakeWorkspace(ports: WorkspaceOpsPorts, workspaceId: string): Promise<{ ok: true } | Refusal> {
    return (await ports.registry.setAsleep(workspaceId, false)) ? { ok: true } : { ok: false, reason: `no workspace ${workspaceId}` };
}

/** Why an agent may not start right now, or `null`. The one rule: an asleep workspace starts nothing. */
/** The plan for a git source (§6.1), written nowhere: the folder derives from the URL under the parent the person picked. */
export async function previewAddFromGit(ports: WorkspaceOpsPorts, url: string, parent: string): Promise<GitAddPlan> {
    const name = repoFolderName(url);
    const path = name ? `${parent.replace(/[\\/]+$/, '')}/${name}` : null;
    return gitAddPlan({ url, parent, folderExists: path !== null && (await ports.fs.exists(path)) });
}

/** Confirm: the clone through the port, then the ordinary add. A failing clone registers nothing and says why in git's words. */
export async function addWorkspaceFromGit(ports: WorkspaceOpsPorts, url: string, parent: string): Promise<Awaited<ReturnType<typeof addWorkspace>>> {
    const plan = await previewAddFromGit(ports, url, parent);
    if (!plan.ok) return plan;
    try {
        await ports.fs.gitClone(plan.url, plan.path);
    } catch (error) {
        return { ok: false, reason: `git clone failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    return addWorkspace(ports, plan.path);
}

/** A manifest's Tynn project (`tynn.projectId`), or `null`: what links a workspace here to a project on Tynn. */
function linkedProjectId(manifest: unknown): string | null {
    const tynn = typeof manifest === 'object' && manifest !== null ? (manifest as { tynn?: { projectId?: unknown } }).tynn : undefined;
    return typeof tynn?.projectId === 'string' && tynn.projectId.length > 0 ? tynn.projectId : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The envelope already names this project on this host (an `owner` it records is its own business, kept). */
const sameLink = (a: unknown, b: TynnLink) => isRecord(a) && a.host === b.host && a.project === b.project && a.projectId === b.projectId;

/**
 * The signed-in person's projects, as Tynn lists them (§6.1 add from Tynn — Genie 1's "your Tynn projects"). A row that is
 * not a project is left out; signed out, or Tynn refusing, is a refusal in Tynn's words. `added`: each listed project
 * already linked to a workspace here (its project.json `tynn.projectId`), by that workspace's id — Genie 1's
 * tynnImportChoices, which kept such a project in the list, marked, rather than letting it silently vanish.
 */
export async function listTynnProjects(ports: WorkspaceOpsPorts): Promise<{ ok: true; host: string; projects: TynnProject[]; added: Record<string, string> } | Refusal> {
    if (!ports.tynn) return { ok: false, reason: 'this Genie has no Tynn client' };
    let rows: unknown[];
    try {
        rows = await ports.tynn.projects();
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const projects = rows.map(parseTynnProject).filter((p): p is TynnProject => p !== null);
    const listed = new Set(projects.map((p) => p.id));
    const added: Record<string, string> = {};
    for (const w of ports.registry.list()) {
        const projectId = linkedProjectId(await ports.fs.readJson(join(w.path, 'project.json')));
        if (projectId !== null && listed.has(projectId) && !(projectId in added)) added[projectId] = w.id;
    }
    return { ok: true, host: ports.tynn.host, projects, added };
}

/**
 * The plan for the CHOSEN Tynn project (§6.1), written nowhere: `<parent>/<slug>.agi`, and what the project brings —
 * the envelope Tynn names, its repositories, or nothing (core/tynn.ts). A project already added here is refused with the
 * workspace to open.
 */
export async function previewAddFromTynn(ports: WorkspaceOpsPorts, parent: string, projectId: string): Promise<TynnAddPlan> {
    const listed = await listTynnProjects(ports);
    if (!listed.ok) return listed;
    const project = listed.projects.find((p) => p.id === projectId);
    if (!project) return { ok: false, reason: `Tynn lists no project ${projectId} for you — it may have been deleted, or shared with someone else` };
    const plan = tynnAddPlan({ project, parent, folderExists: await ports.fs.exists(tynnEnvelopePath(parent, project)), host: listed.host, addedAs: listed.added[project.id] ?? null });
    if (plan.ok && ports.registry.workspace(plan.id)) return { ok: false, reason: alreadyNamed(plan.id) };
    return plan;
}

/**
 * Confirm: what the plan showed, then the workspace registered (Add workspace parity item 3; Genie 1's
 * add-workspace.ts). Tynn names an envelope → clone it with its submodules on its branch, and write the `tynn` link into
 * its project.json only when it is not already that link (the person's envelope is otherwise left exactly as cloned).
 * No envelope → a new one, laid out and committed as New's is, each repository a submodule under `repos/` on its branch,
 * recorded in `repos[]`, and committed. Nothing is registered until the last write succeeded.
 */
export async function addWorkspaceFromTynn(ports: WorkspaceOpsPorts, parent: string, projectId: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: null } | Refusal> {
    const plan = await previewAddFromTynn(ports, parent, projectId);
    if (!plan.ok) return plan;
    const { content, path, id } = plan;
    const manifestPath = join(path, 'project.json');
    const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

    if (content.kind === 'envelope') {
        try {
            await ports.fs.gitClone(content.url, path, content.branch);
        } catch (error) {
            return { ok: false, reason: `git clone failed: ${why(error)}` };
        }
        const current = await ports.fs.readJson(manifestPath);
        if (!isRecord(current)) await ports.fs.writeJson(manifestPath, { ...freshManifest(path, 'empty'), ...plan.manifest });
        else if (!sameLink(current.tynn, plan.manifest.tynn)) await ports.fs.writeJson(manifestPath, { ...current, tynn: plan.manifest.tynn });
        await ports.registry.addWorkspace({ id, path, envFile: registeredEnvFile(ports) });
        return { ok: true, id, kind: plan.kind, stamped: null };
    }

    await ports.fs.mkdir(path);
    const folder = basename(path);
    const problem = await scaffoldEnvelope(ports, path, folder, { ...plan.manifest });
    if (problem) return { ok: false, reason: problem };

    if (content.kind === 'repos') {
        // The manifest as the first commit has it; each repo is added to it as git adds the submodule.
        const written = await ports.fs.readJson(manifestPath);
        let manifest: Record<string, unknown> = isRecord(written) ? written : { ...freshManifest(path, 'empty'), ...plan.manifest };
        for (const repo of content.repos) {
            const at = `repos/${repo.name}`;
            let branch: string | null;
            try {
                branch = await ports.fs.gitAddSubmodule(path, repo.url, at, repo.branch);
            } catch (error) {
                return { ok: false, reason: `Genie made ${path} and its first commit, but could not add ${repo.url} as ${at}: ${why(error)}` };
            }
            const added = addRepo(manifest, { name: repo.name, path: at, url: repo.url });
            if (!added.ok) return { ok: false, reason: `Genie made ${path}, but could not record ${at}: ${added.reason}` };
            const repos = (added.manifest.repos as Array<Record<string, unknown>>).map((r) => (r.slug === added.slug && branch ? { ...r, branch } : r));
            manifest = { ...added.manifest, repos };
        }
        await ports.fs.writeJson(manifestPath, manifest);
        const n = content.repos.length;
        try {
            await ports.fs.gitCommit(path, `Add ${n} ${n === 1 ? 'repository' : 'repositories'} from Tynn project ${plan.project.name} as submodules`);
        } catch (error) {
            return { ok: false, reason: `Genie added the repositories to ${path}, but git could not commit them: ${why(error)}` };
        }
    }

    await ports.registry.addWorkspace({ id, path, envFile: registeredEnvFile(ports) });
    return { ok: true, id, kind: 'empty', stamped: null };
}

export function startRefusal(ports: Pick<WorkspaceOpsPorts, 'registry'>, record: AgentRecord, load?: { running: number; cap: number }): string | null {
    const workspace = ports.registry.workspace(record.workspaceId);
    if (workspace?.asleep) return `${workspace.id} is hibernating; wake it before starting ${record.name}`;
    // §6.1 caps: a start past the cap is refused with the number and the setting named — never queued, never silent.
    if (load && load.running >= load.cap) return `${record.workspaceId} is at its cap of ${load.cap} running agents; stop one or raise agent_cap in the workspace settings before starting ${record.name}`;
    return null;
}

export async function removeWorkspace(ports: WorkspaceOpsPorts, workspaceId: string): Promise<{ ok: true; agentsForgotten: number; path: string; folderUntouched: true } | Refusal> {
    const workspace = ports.registry.workspace(workspaceId);
    if (!workspace) return { ok: false, reason: `no workspace ${workspaceId}` };
    for (const a of ports.registry.agentsOf(workspaceId)) if (ports.host.probe(a.id)?.running) ports.host.stop(a.id);
    const forgotten = await ports.registry.forgetWorkspace(workspaceId);
    if (!forgotten) return { ok: false, reason: `no workspace ${workspaceId}` };
    return { ok: true, agentsForgotten: forgotten.agentsForgotten, path: workspace.path, folderUntouched: true };
}

/**
 * A NEW WORKSPACE, AS GENIE 1 MADE ONE (the owner, 2026-10-21: "I can't create workspaces at all right now"; Genie 1's
 * createAgiEnvelope): a NAME and a FOLDER; Genie makes `<folder>/<slug>.agi`, the envelope, and its first git commit. Every
 * refusal comes before anything is written: no name, no folder, a folder that does not exist, a name already a
 * workspace, a target that is not empty ("use Open existing folder on it").
 *
 * The first commit is the card's promise ("Genie makes the folder and its first commit", AddWorkspaceModal.tsx); Genie 2
 * kept it in words only — a bare `git init`, no commit, no branch, no README, no .gitignore — until Add workspace parity
 * item 1. The scaffold is Genie 1's (core/add-workspace.ts). The workspace is registered only once the commit exists, so
 * a git that refuses leaves nothing half-added in Genie.
 */
export async function createWorkspace(ports: WorkspaceOpsPorts, name: string, parent: string, remote?: RemoteChoice): Promise<{ ok: true; id: string; path: string; published?: Published } | Refusal> {
    const problem = remote ? remoteChoiceProblem(remote) : null;
    if (problem) return { ok: false, reason: problem };
    const made = await makeNewEnvelope(ports, name, parent);
    if (!made.ok) return made;
    await ports.registry.addWorkspace({ id: made.id, path: made.path, envFile: registeredEnvFile(ports) });
    const published = await publishNew(ports, made.path, remote);
    return published ? { ...made, published } : made;
}

/**
 * The made, registered envelope to the remote the person chose (Add workspace parity item 11; agi-remote-host.ts). None,
 * or no choice at all, touches nothing. Whatever GitHub, git or Tynn answer, the workspace stays made and registered: the
 * result carries each failed step in that service's words. A host with no remote ports wired says so as a problem.
 */
export async function publishNew(ports: WorkspaceOpsPorts, path: string, remote: RemoteChoice | undefined): Promise<Published | null> {
    if (!remote) return null;
    if (!ports.remote && remote.kind === 'none') return { remote: null, repo: null, pushed: false, tynn: 'not-linked', problems: [] };
    if (!ports.remote) return { remote: null, repo: null, pushed: false, tynn: 'not-linked', problems: [{ step: remote.kind === 'github' ? 'github' : 'remote', message: 'This Genie cannot set a remote for a workspace; the workspace is on this machine.' }] };
    try {
        return await publishEnvelope(ports.remote, { path, name: basename(path) }, remote);
    } catch (error) {
        // publishEnvelope reports every step it knows; anything else is still not allowed to un-make the workspace.
        return { remote: null, repo: null, pushed: false, tynn: 'not-linked', problems: [{ step: 'remote', message: `Genie could not finish setting the workspace's remote: ${error instanceof Error ? error.message : String(error)}` }] };
    }
}

/**
 * New's envelope — its refusals, then `<parent>/<slug>.agi` laid out with its real first commit (scaffoldEnvelope) —
 * WITHOUT registering it. New registers it at once; the Open existing / Import from Git wizard (envelope-wizard-host.ts)
 * first adds the person's repos and knowledge. One envelope writer for all three.
 */
export async function makeNewEnvelope(ports: WorkspaceOpsPorts, name: string, parent: string): Promise<{ ok: true; id: string; path: string } | Refusal> {
    const problem = newWorkspaceProblem(name, parent);
    if (problem) return { ok: false, reason: problem };
    const at = parent.trim();
    if (!(await ports.fs.exists(at))) return { ok: false, reason: `${at} does not exist; pick a folder that does` };
    const folder = workspaceFolderName(name);
    const id = folder.replace(/\.agi$/, '');
    if (ports.registry.workspace(id)) return { ok: false, reason: alreadyNamed(id) };
    const target = join(at, folder);
    const there = await ports.fs.exists(target);
    if (there && (await ports.fs.entries(target)).length > 0) return { ok: false, reason: `${target} is not empty. Choose another name or folder, or use Open existing folder on it.` };
    if (!there) await ports.fs.mkdir(target);
    const failed = await scaffoldEnvelope(ports, target, folder, { name: name.trim() });
    if (failed) return { ok: false, reason: failed };
    return { ok: true, id, path: target };
}

/**
 * THE NEW ENVELOPE, laid out and committed (Genie 1's createAgiEnvelope) — what New makes, and what the Tynn import makes
 * when Tynn names no envelope: the folders with their .gitkeep, `project.json` (the fresh manifest under `manifest`),
 * Genie 1's .gitignore plus the agent-file lines, README/RULES, the AGENTS.md and CLAUDE.md routers, and the first commit
 * on `main`. The folder must exist. A git that refuses is the reason returned; `null` = made.
 */
async function scaffoldEnvelope(ports: WorkspaceOpsPorts, target: string, folder: string, manifest: { name: string } & Record<string, unknown>): Promise<string | null> {
    const title = manifest.name;
    for (const d of ENVELOPE_DIRS) {
        await ports.fs.mkdir(join(target, d));
        await ports.fs.writeText(join(target, d, '.gitkeep'), '');
    }
    await ports.fs.writeJson(join(target, 'project.json'), { ...freshManifest(target, 'empty'), ...manifest });
    // Genie 1's ignores, then the lines Genie's agent-file sync adds (the files carrying its MCP token), so the token can
    // never be committed and the first sync has nothing left to append.
    let gitignore = ENVELOPE_GITIGNORE;
    await writeAgentGitignore({ workspacePath: target, fs: { read: async () => gitignore, write: async (_p, text) => { gitignore = text; } } });
    await ports.fs.writeText(join(target, '.gitignore'), gitignore);
    await ports.fs.writeText(join(target, 'README.md'), envelopeReadme(title, folder));
    await ports.fs.writeText(join(target, 'RULES.md'), envelopeRules(title));
    // Real files, never a symlink: agent-routers.ts replaces a symlinked harness file (Genie 1 wrote the Claude router
    // through its CLAUDE.md symlink into AGENTS.md), and a Windows checkout has no symlink to give.
    const has = { readme: true, operator: false };
    await ports.fs.writeText(join(target, 'AGENTS.md'), routerText('codex', has));
    await ports.fs.writeText(join(target, 'CLAUDE.md'), routerText('claude', has));
    try {
        await ports.fs.gitFirstCommit(target, firstCommitMessage(folder));
    } catch (error) {
        return `Genie made ${target}, but git could not make its first commit: ${error instanceof Error ? error.message : String(error)}`;
    }
    return null;
}
