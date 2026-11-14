import { join } from 'node:path';
import { agentConfigWrite } from '../core/agent-config.js';
import { agentFileText, agentSlug, newAgentRefusal } from '../core/agent-create.js';
import type { AcpProvider } from '../core/engine.js';
import { moveAgentFrontmatter, type AgentConfigFs } from './agent-config-host.js';

/**
 * A NEW AGENT ON THE HOST (Genie 1's `registerAgentInWorkspace`, the one core its form and its MCP tool shared): the form
 * re-checked here (the window is not trusted, and the list may be stale), `.agents/<name>/AGENT.md` written — NEVER over
 * one that is already there, whose words are someone's — and then the agent registered with that file as its
 * instructions, on the provider chosen. The file is what makes Unmount safe: an agent with nothing on disk was lost the
 * moment it was unmounted (genie#1113's finding). Every port is injected; main.ts passes the real ones.
 *
 * THE CONFIG IN project.json, THE PERSONA IN AGENT.md (Tynn #694): the purpose and provider are written to the workspace's
 * project.json `agents.<name>` (core/agent-config.ts) FIRST — a project.json Genie may not write refuses the create before
 * anything is written — and AGENT.md is only the persona, the purpose said once. Any old front matter in the workspace is
 * moved first (main/agent-config-host.ts): creating an agent is reading its workspace.
 */

export interface AgentCreatePorts extends AgentConfigFs {
    workspace(id: string): { id: string; path: string } | null;
    agentsOf(workspaceId: string): readonly { name: string }[];
    exists(path: string): Promise<boolean>;
    mkdirp(dir: string): Promise<void>;
    register(input: { workspaceId: string; provider: AcpProvider; name: string; instructions: string }): Promise<{ id: string; name: string }>;
    /** The workspace's sacred grant from its linked Tynn project; a failure grants nothing. */
    sacredName?(workspaceId: string): Promise<string | null>;
}

export type AgentCreateResult = { ok: true; id: string; name: string } | { ok: false; reason: string };

/** Creates in flight, by workspace and name: two presses (or two windows) create the agent once. */
const inFlight = new Set<string>();

export async function createAgent(
    ports: AgentCreatePorts,
    workspaceId: string,
    input: { name: string; purpose: string; provider: string },
): Promise<AgentCreateResult> {
    const workspace = ports.workspace(workspaceId);
    if (!workspace) return { ok: false, reason: `no workspace ${workspaceId}` };
    const name = agentSlug(input.name);
    const key = `${workspaceId}\u0000${name}`;
    if (inFlight.has(key)) return { ok: false, reason: `${name} is already being created` };
    inFlight.add(key);
    try {
        let sacredName: string | null = null;
        try { sacredName = (await ports.sacredName?.(workspaceId)) ?? null; } catch { sacredName = null; }
        const refusal = newAgentRefusal({ name, purpose: input.purpose, provider: input.provider, existing: ports.agentsOf(workspaceId).map((a) => a.name), sacredName });
        if (refusal !== null) return { ok: false, reason: refusal };

        await moveAgentFrontmatter(ports, workspace.path);
        const manifestPath = join(workspace.path, 'project.json');
        const purpose = input.purpose.replace(/\s+/g, ' ').trim();
        const config = agentConfigWrite(await ports.readText(manifestPath), { [name]: { purpose, provider: input.provider } });
        if (!config.ok) return { ok: false, reason: `the agent was not created: ${config.reason}` };
        if (config.changed) {
            if (config.backup) await ports.writeTextAtomic(join(workspace.path, config.backup.name), config.backup.text);
            await ports.writeTextAtomic(manifestPath, config.text);
        }
        const dir = join(workspace.path, '.agents', name);
        const file = join(dir, 'AGENT.md');
        if (!(await ports.exists(file))) {
            await ports.mkdirp(dir);
            await ports.writeTextAtomic(file, agentFileText({ name, purpose }));
        }
        const record = await ports.register({ workspaceId, provider: input.provider as AcpProvider, name, instructions: `.agents/${name}/AGENT.md` });
        return { ok: true, id: record.id, name: record.name };
    } catch (error) {
        return { ok: false, reason: `the agent was not created: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
        inFlight.delete(key);
    }
}
