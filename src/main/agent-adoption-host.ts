import { join } from 'node:path';
import { importedAgents, type AgentFile, type ImportedAgent } from '../core/agent-adoption.js';
import { agentConfigsOf } from '../core/agent-config.js';
import type { AcpProvider } from '../core/engine.js';
import type { IssueWatchSetting } from '../core/issue-watch.js';
import { moveAgentFrontmatter, type AgentConfigFs } from './agent-config-host.js';

/**
 * "IT CAME WITH AGENTS" ON THE HOST (Add workspace parity item 6; Genie 1's agents:roster / agents:adopt). Reads a
 * workspace's `.agents/<name>/AGENT.md` files and the registry, and adopts one on request: registered in the registry with
 * its AGENT.md as its instructions, on the provider its project.json `agents.<name>` names (Tynn #694). Listing is reading
 * the workspace, so it first MOVES any old AGENT.md front matter into project.json (main/agent-config-host.ts) — the one
 * write here; adopting never writes anything else. Every port is injected; main.ts passes the real ones.
 */

export interface AgentAdoptionPorts extends AgentConfigFs {
    workspace(id: string): { id: string; path: string } | null;
    agentsOf(workspaceId: string): readonly { name: string }[];
    register(input: { workspaceId: string; provider: AcpProvider; name: string; instructions: string }): Promise<{ id: string; name: string }>;
    /** The workspace's sacred grant from its linked Tynn project (`sacred_agent_name`); a failure grants nothing. */
    sacredName?(workspaceId: string): Promise<string | null>;
    /** Set an adopted agent's IssueWatch from its config (Tynn #756, PR8). Absent: not applied. */
    setIssueWatch?(agentId: string, setting: IssueWatchSetting): Promise<unknown>;
    /** The workspace's default agent (by id), or null; and make one the default (Tynn #756, PR8). Absent: not applied. */
    defaultAgentOf?(workspaceId: string): string | null;
    setDefaultAgent?(workspaceId: string, agentId: string): Promise<unknown>;
}

type Refusal = { ok: false; reason: string };

/** A folder name that is a single path segment (anything else is never read, let alone registered). */
const SEGMENT = /^[^\\/]+$/;

async function sacredOf(ports: AgentAdoptionPorts, workspaceId: string): Promise<string | null> {
    try {
        return (await ports.sacredName?.(workspaceId)) ?? null;
    } catch {
        return null;
    }
}

/** The agents a workspace brought and has not registered — each with its reason when it cannot be adopted. */
export async function readImportedAgents(ports: AgentAdoptionPorts, workspaceId: string): Promise<{ ok: true; agents: ImportedAgent[] } | Refusal> {
    const workspace = ports.workspace(workspaceId);
    if (!workspace) return { ok: false, reason: `no workspace ${workspaceId}` };
    // A move that cannot be made (no project.json, a newer schema) leaves the files as they are; the listing goes on.
    await moveAgentFrontmatter(ports, workspace.path);
    const dir = join(workspace.path, '.agents');
    let folders: readonly string[];
    try {
        folders = await ports.listDirs(dir);
    } catch {
        // No .agents/ (or a folder that moved): nothing came with it — the ordinary case, not an error.
        return { ok: true, agents: [] };
    }
    const files: AgentFile[] = [];
    for (const folder of folders) {
        // Only a folder holding an AGENT.md is an agent: `_genie/` and `skills/` live here too.
        if (!SEGMENT.test(folder) || folder === '.' || folder === '..') continue;
        const text = await ports.readText(join(dir, folder, 'AGENT.md'));
        if (text !== null) files.push({ folder });
    }
    let manifest: unknown = null;
    try { manifest = JSON.parse((await ports.readText(join(workspace.path, 'project.json'))) ?? 'null'); } catch { manifest = null; }
    return { ok: true, agents: importedAgents({ files, registered: ports.agentsOf(workspaceId), configs: agentConfigsOf(manifest), sacredName: await sacredOf(ports, workspaceId) }) };
}

/** The default agent project.json's `workspace` names, or null. */
async function declaredDefaultAgent(ports: AgentAdoptionPorts, workspaceId: string): Promise<string | null> {
    const folder = ports.workspace(workspaceId)?.path;
    if (!folder) return null;
    try {
        const manifest = JSON.parse((await ports.readText(join(folder, 'project.json'))) ?? 'null') as { workspace?: { defaultAgent?: unknown } } | null;
        const name = manifest?.workspace?.defaultAgent;
        return typeof name === 'string' ? name : null;
    } catch {
        return null;
    }
}

/** Adoptions in flight, by workspace and name: two clicks (or two windows) at once register the agent once. */
const inFlight = new Set<string>();

/**
 * Adopt one: re-read (the list may be stale), then register it exactly once — never a refused name, never a name the
 * workspace already has, never one with no AGENT.md here.
 */
export async function adoptAgent(ports: AgentAdoptionPorts, workspaceId: string, name: string): Promise<{ ok: true; id: string; name: string } | Refusal> {
    const key = `${workspaceId}\u0000${name.toLowerCase()}`;
    if (inFlight.has(key)) return { ok: false, reason: `${name} is already being adopted` };
    inFlight.add(key);
    try {
        if (ports.agentsOf(workspaceId).some((a) => a.name.trim().toLowerCase() === name.toLowerCase())) return { ok: false, reason: `${workspaceId} already has an agent named ${name}` };
        const read = await readImportedAgents(ports, workspaceId);
        if (!read.ok) return read;
        const agent = read.agents.find((a) => a.name === name);
        if (!agent) return { ok: false, reason: `${workspaceId} has no unregistered agent ${name} in .agents/` };
        if (agent.refusal !== null || agent.provider === null) return { ok: false, reason: agent.refusal ?? `${name} cannot be adopted` };
        const record = await ports.register({ workspaceId, provider: agent.provider, name: agent.name, instructions: agent.instructions });
        // What project.json says of this agent comes with it: how it hears IssueWatch, and whether it is the workspace's default
        // agent (only where the workspace has none: a person's choice here is never replaced). Never a capability grant.
        if (agent.issueWatch && ports.setIssueWatch) await ports.setIssueWatch(record.id, agent.issueWatch);
        if (ports.setDefaultAgent && ports.defaultAgentOf?.(workspaceId) === null && (await declaredDefaultAgent(ports, workspaceId))?.toLowerCase() === agent.name.toLowerCase()) {
            await ports.setDefaultAgent(workspaceId, record.id);
        }
        return { ok: true, id: record.id, name: record.name };
    } finally {
        inFlight.delete(key);
    }
}
