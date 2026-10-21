import { basename, join } from 'node:path';
import type { AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import { classifyFolder, gitAddPlan, hibernate, planAdd, repoFolderName, stampSchema, SCHEMA_REVISION, type FolderKind, type GitAddPlan, type PlanStep } from '../core/workspace-model.js';
import { newWorkspaceProblem, workspaceFolderName } from '../core/add-workspace.js';
import { parseTynnProject, tynnAddPlan, tynnLink, type TynnAddPlan, type TynnProject } from '../core/tynn.js';

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
        gitInit(path: string): Promise<void>;
        /** `git clone <url> <into>`; rejects with git's own words. */
        gitClone(url: string, into: string): Promise<void>;
    };
    registry: {
        workspace(id: string): { id: string; path: string; asleep: boolean } | null;
        addWorkspace(record: { id: string; path: string }): Promise<void>;
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

export async function addWorkspace(ports: WorkspaceOpsPorts, path: string, overlay?: Record<string, unknown>, id: string = basename(path)): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | Refusal> {
    const preview = await previewAddWorkspace(ports, path, id);
    if (!preview.ok) return preview;
    const manifestPath = join(path, 'project.json');
    let stamped: { from: string | null; backup: string } | null = null;

    if (preview.kind === 'full-envelope') {
        const current = await ports.fs.readJson(manifestPath);
        const manifest = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
        const stamp = stampSchema(manifest, SCHEMA_REVISION);
        if (!stamp.ok) return stamp;
        if (stamp.backup) {
            await ports.fs.writeJson(join(path, stamp.backup), manifest);
            await ports.fs.writeJson(manifestPath, stamp.manifest);
            stamped = { from: stamp.from, backup: stamp.backup };
        }
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

    await ports.registry.addWorkspace({ id, path });
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

/**
 * The signed-in person's projects, as Tynn lists them (§6.1 add from Tynn — Genie 1's "your Tynn projects"). A row that is
 * not a project is left out; signed out, or Tynn refusing, is a refusal in Tynn's words.
 */
export async function listTynnProjects(ports: WorkspaceOpsPorts): Promise<{ ok: true; host: string; projects: TynnProject[] } | Refusal> {
    if (!ports.tynn) return { ok: false, reason: 'this Genie has no Tynn client' };
    let rows: unknown[];
    try {
        rows = await ports.tynn.projects();
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, host: ports.tynn.host, projects: rows.map(parseTynnProject).filter((p): p is TynnProject => p !== null) };
}

/** The plan for the CHOSEN Tynn project (§6.1), written nowhere: the folder derives from its slug under the parent. */
export async function previewAddFromTynn(ports: WorkspaceOpsPorts, parent: string, projectId: string): Promise<TynnAddPlan> {
    const listed = await listTynnProjects(ports);
    if (!listed.ok) return listed;
    const project = listed.projects.find((p) => p.id === projectId);
    if (!project) return { ok: false, reason: `Tynn lists no project ${projectId} for you — it may have been deleted, or shared with someone else` };
    const path = `${parent.replace(/[\\/]+$/, '')}/${project.slug}`;
    return tynnAddPlan({ project, parent, folderExists: await ports.fs.exists(path), host: listed.host });
}

/** Confirm: create the folder, then the ordinary add of an EMPTY folder with the manifest the plan showed. */
export async function addWorkspaceFromTynn(ports: WorkspaceOpsPorts, parent: string, projectId: string): Promise<Awaited<ReturnType<typeof addWorkspace>>> {
    const plan = await previewAddFromTynn(ports, parent, projectId);
    if (!plan.ok) return plan;
    await ports.fs.mkdir(plan.path);
    return addWorkspace(ports, plan.path, plan.manifest);
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
 * Optionally LINKED to a Tynn project (Genie 1's "Project (optional)"): `tynnProjectId` is looked up in Tynn's own list
 * of the person's projects — never taken from the window — and written as project.json's `tynn`, as Import from Tynn
 * writes it. A project Tynn does not list, or no Tynn to ask, is refused before anything is written.
 */
export async function createWorkspace(ports: WorkspaceOpsPorts, name: string, parent: string, tynnProjectId?: string): Promise<{ ok: true; id: string; path: string } | Refusal> {
    const problem = newWorkspaceProblem(name, parent);
    if (problem) return { ok: false, reason: problem };
    let tynn: ReturnType<typeof tynnLink> | null = null;
    if (tynnProjectId !== undefined && tynnProjectId !== '') {
        const listed = await listTynnProjects(ports);
        if (!listed.ok) return listed;
        const project = listed.projects.find((p) => p.id === tynnProjectId);
        if (!project) return { ok: false, reason: `Tynn lists no project ${tynnProjectId} for you — it may have been deleted, or shared with someone else` };
        tynn = tynnLink(project, listed.host);
    }
    const at = parent.trim();
    if (!(await ports.fs.exists(at))) return { ok: false, reason: `${at} does not exist; pick a folder that does` };
    const folder = workspaceFolderName(name);
    const id = folder.replace(/\.agi$/, '');
    if (ports.registry.workspace(id)) return { ok: false, reason: alreadyNamed(id) };
    const target = join(at, folder);
    const there = await ports.fs.exists(target);
    if (there && (await ports.fs.entries(target)).length > 0) return { ok: false, reason: `${target} is not empty. Choose another name or folder, or use Open existing folder on it.` };
    if (!there) await ports.fs.mkdir(target);
    const added = await addWorkspace(ports, target, { name: name.trim(), ...(tynn ? { tynn } : {}) }, id);
    return added.ok ? { ok: true, id: added.id, path: target } : added;
}
