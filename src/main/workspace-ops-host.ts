import { basename, join } from 'node:path';
import type { AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import { classifyFolder, hibernate, planAdd, stampSchema, SCHEMA_REVISION, type FolderKind, type PlanStep } from '../core/workspace-model.js';

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
}

type Refusal = { ok: false; reason: string };

export type AddPreview = { ok: true; path: string; kind: FolderKind; steps: PlanStep[] } | Refusal;

export async function previewAddWorkspace(ports: WorkspaceOpsPorts, path: string): Promise<AddPreview> {
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

export async function addWorkspace(ports: WorkspaceOpsPorts, path: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | Refusal> {
    const preview = await previewAddWorkspace(ports, path);
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
        await ports.fs.writeJson(manifestPath, freshManifest(path, preview.kind));
        if (preview.kind === 'empty') await ports.fs.gitInit(path);
    }

    const id = basename(path);
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
export function startRefusal(ports: Pick<WorkspaceOpsPorts, 'registry'>, record: AgentRecord): string | null {
    const workspace = ports.registry.workspace(record.workspaceId);
    return workspace?.asleep ? `${workspace.id} is hibernating; wake it before starting ${record.name}` : null;
}

export async function removeWorkspace(ports: WorkspaceOpsPorts, workspaceId: string): Promise<{ ok: true; agentsForgotten: number; path: string; folderUntouched: true } | Refusal> {
    const workspace = ports.registry.workspace(workspaceId);
    if (!workspace) return { ok: false, reason: `no workspace ${workspaceId}` };
    for (const a of ports.registry.agentsOf(workspaceId)) if (ports.host.probe(a.id)?.running) ports.host.stop(a.id);
    const forgotten = await ports.registry.forgetWorkspace(workspaceId);
    if (!forgotten) return { ok: false, reason: `no workspace ${workspaceId}` };
    return { ok: true, agentsForgotten: forgotten.agentsForgotten, path: workspace.path, folderUntouched: true };
}
