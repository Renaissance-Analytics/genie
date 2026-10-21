import { join } from 'node:path';
import { importedAgents, type AgentFile, type ImportedAgent } from '../core/agent-adoption.js';
import type { AcpProvider } from '../core/engine.js';

/**
 * "IT CAME WITH AGENTS" ON THE HOST (Add workspace parity item 6; Genie 1's agents:roster / agents:adopt). Reads a
 * workspace's `.agents/<name>/AGENT.md` files and the registry, and adopts one on request: registered in the registry with
 * its AGENT.md as its instructions, on the provider the file allows. These ports can only READ the workspace — adopting
 * never writes to the file or the folder. Every port is injected; main.ts passes the real ones.
 */

export interface AgentAdoptionPorts {
    workspace(id: string): { id: string; path: string } | null;
    agentsOf(workspaceId: string): readonly { name: string }[];
    /** The folders directly under `dir`; rejects when it does not exist. */
    listDirs(dir: string): Promise<readonly string[]>;
    /** A file's text, or `null` when there is none. */
    readText(path: string): Promise<string | null>;
    register(input: { workspaceId: string; provider: AcpProvider; name: string; instructions: string }): Promise<{ id: string; name: string }>;
    /** The workspace's sacred grant from its linked Tynn project (`sacred_agent_name`); a failure grants nothing. */
    sacredName?(workspaceId: string): Promise<string | null>;
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
        if (text !== null) files.push({ folder, text });
    }
    return { ok: true, agents: importedAgents({ files, registered: ports.agentsOf(workspaceId), sacredName: await sacredOf(ports, workspaceId) }) };
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
        return { ok: true, id: record.id, name: record.name };
    } finally {
        inFlight.delete(key);
    }
}
