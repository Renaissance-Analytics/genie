import { join } from 'node:path';
import { importedAgents, type AgentFile, type ImportedAgent, type TynnProjectAgent } from '../core/agent-adoption.js';
import { agentConfigsOf } from '../core/agent-config.js';
import { agentFileText } from '../core/agent-create.js';
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
    /**
     * The default someone CHOSE (by id), or null — an automatic one (the first agent, Tynn #1015) is not, so project.json's
     * declaration replaces it; and make one the default (Tynn #756, PR8). Absent: not applied.
     */
    chosenDefaultAgentOf?(workspaceId: string): string | null;
    setDefaultAgent?(workspaceId: string, agentId: string): Promise<unknown>;
    /**
     * TYNN'S AGENTS FOR THE WORKSPACE'S PROJECT (Tynn #1016): offered beside those on disk. `null` = none to read (signed out,
     * not linked, Tynn unreachable): the offer is the repo's alone, as before. Absent: not read.
     */
    tynnAgents?(workspaceId: string): Promise<readonly TynnProjectAgent[] | null>;
    /** Make a folder (a Tynn agent's persona, written when the clone has none). Absent: a Tynn-only agent is refused. */
    mkdirp?(dir: string): Promise<void>;
    /**
     * MOUNT IT NOW (Tynn #1016; the owner's ruling #1003: keys are minted per person on mount): its own Tynn key and the
     * settings Tynn holds, before anyone starts it. A failure here undoes nothing: it mounts at its first start.
     */
    mount?(agentId: string): Promise<unknown>;
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
        // No .agents/ (or a folder that moved): nothing came with it on disk — the ordinary case, not an error.
        folders = [];
    }
    let tynn: readonly TynnProjectAgent[] | null = null;
    try { tynn = (await ports.tynnAgents?.(workspaceId)) ?? null; } catch { tynn = null; }
    const files: AgentFile[] = [];
    for (const folder of folders) {
        // Only a folder holding an AGENT.md is an agent: `_genie/` and `skills/` live here too.
        if (!SEGMENT.test(folder) || folder === '.' || folder === '..') continue;
        const text = await ports.readText(join(dir, folder, 'AGENT.md'));
        if (text !== null) files.push({ folder });
    }
    let manifest: unknown = null;
    try { manifest = JSON.parse((await ports.readText(join(workspace.path, 'project.json'))) ?? 'null'); } catch { manifest = null; }
    return { ok: true, agents: importedAgents({ files, registered: ports.agentsOf(workspaceId), configs: agentConfigsOf(manifest), sacredName: await sacredOf(ports, workspaceId), tynn }) };
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
export async function adoptAgent(ports: AgentAdoptionPorts, workspaceId: string, name: string, read?: { ok: true; agents: ImportedAgent[] }, tynnPurpose?: string | null): Promise<{ ok: true; id: string; name: string } | Refusal> {
    const key = `${workspaceId}\u0000${name.toLowerCase()}`;
    if (inFlight.has(key)) return { ok: false, reason: `${name} is already being adopted` };
    inFlight.add(key);
    try {
        if (ports.agentsOf(workspaceId).some((a) => a.name.trim().toLowerCase() === name.toLowerCase())) return { ok: false, reason: `${workspaceId} already has an agent named ${name}` };
        const listed = read ?? await readImportedAgents(ports, workspaceId);
        if (!listed.ok) return listed;
        const agent = listed.agents.find((a) => a.name === name);
        if (!agent) return { ok: false, reason: `${workspaceId} has no unregistered agent ${name} in .agents/` };
        if (agent.refusal !== null || agent.provider === null) return { ok: false, reason: agent.refusal ?? `${name} cannot be adopted` };
        // A Tynn agent this clone has no persona for (Tynn #1016): its AGENT.md is written, as creating it would — never over one.
        if (agent.fromTynn) {
            const folder = ports.workspace(workspaceId)?.path;
            if (!folder || !ports.mkdirp) return { ok: false, reason: `${name} is in Tynn but has no .agents/${name}/AGENT.md here, and this host cannot write one` };
            const file = join(folder, '.agents', name, 'AGENT.md');
            if ((await ports.readText(file)) === null) {
                await ports.mkdirp(join(folder, '.agents', name));
                await ports.writeTextAtomic(file, agentFileText({ name, purpose: tynnPurpose?.replace(/\s+/g, ' ').trim() || `${name}, from the Tynn project` }));
            }
        }
        const record = await ports.register({ workspaceId, provider: agent.provider, name: agent.name, instructions: agent.instructions });
        // What project.json says of this agent comes with it: how it hears IssueWatch, and whether it is the workspace's default
        // agent (only where nobody chose one: a person's choice here is never replaced; the automatic first agent is). Never a capability grant.
        if (agent.issueWatch && ports.setIssueWatch) await ports.setIssueWatch(record.id, agent.issueWatch);
        if (ports.setDefaultAgent && ports.chosenDefaultAgentOf?.(workspaceId) === null && (await declaredDefaultAgent(ports, workspaceId))?.toLowerCase() === agent.name.toLowerCase()) {
            await ports.setDefaultAgent(workspaceId, record.id);
        }
        return { ok: true, id: record.id, name: record.name };
    } finally {
        inFlight.delete(key);
    }
}

/**
 * ADOPT THEM ALL, IN ONE STEP (Tynn #1016; the P8 measurement: each had to be adopted one at a time). Every agent the
 * workspace is offered — on disk or in Tynn — but the ones the person opted out of, each by the one-agent rules above, then
 * mounted at once: its own Tynn key and the settings Tynn holds (`mount`). A refusal is said per agent and stops no other;
 * a mount that fails is said and undoes nothing.
 */
export async function adoptAgents(ports: AgentAdoptionPorts, workspaceId: string, options: { except: readonly string[] }): Promise<{ ok: true; adopted: Array<{ name: string; id: string; mount?: string }>; refused: Array<{ name: string; reason: string }> } | Refusal> {
    const read = await readImportedAgents(ports, workspaceId);
    if (!read.ok) return read;
    let purposes: ReadonlyMap<string, string | null> = new Map();
    try { purposes = new Map(((await ports.tynnAgents?.(workspaceId)) ?? []).map((t) => [t.name, t.purpose ?? null])); } catch { /* the persona says less; nothing else changes */ }
    const skip = new Set(options.except.map((n) => n.toLowerCase()));
    const adopted: Array<{ name: string; id: string; mount?: string }> = [];
    const refused: Array<{ name: string; reason: string }> = [];
    for (const agent of read.agents) {
        if (skip.has(agent.name.toLowerCase()) || agent.refusal !== null) continue;
        const r = await adoptAgent(ports, workspaceId, agent.name, read, purposes.get(agent.name) ?? null);
        if (!r.ok) { refused.push({ name: agent.name, reason: r.reason }); continue; }
        let mount: string | undefined;
        try { await ports.mount?.(r.id); } catch (error) { mount = error instanceof Error ? error.message : String(error); }
        adopted.push({ name: r.name, id: r.id, ...(mount !== undefined ? { mount } : {}) });
    }
    return { ok: true, adopted, refused };
}
