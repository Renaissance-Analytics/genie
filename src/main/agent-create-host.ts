import { join } from 'node:path';
import { agentFileText, agentSlug, newAgentRefusal } from '../core/agent-create.js';
import type { AcpProvider } from '../core/engine.js';

/**
 * A NEW AGENT ON THE HOST (Genie 1's `registerAgentInWorkspace`, the one core its form and its MCP tool shared): the form
 * re-checked here (the window is not trusted, and the list may be stale), `.agents/<name>/AGENT.md` written — NEVER over
 * one that is already there, whose words are someone's — and then the agent registered with that file as its
 * instructions, on the provider chosen. The file is what makes Unmount safe: an agent with nothing on disk was lost the
 * moment it was unmounted (genie#1113's finding). Every port is injected; main.ts passes the real ones.
 */

export interface AgentCreatePorts {
    workspace(id: string): { id: string; path: string } | null;
    agentsOf(workspaceId: string): readonly { name: string }[];
    exists(path: string): Promise<boolean>;
    mkdirp(dir: string): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
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

        const dir = join(workspace.path, '.agents', name);
        const file = join(dir, 'AGENT.md');
        if (!(await ports.exists(file))) {
            await ports.mkdirp(dir);
            await ports.writeText(file, agentFileText({ name, purpose: input.purpose, provider: input.provider }));
        }
        const record = await ports.register({ workspaceId, provider: input.provider as AcpProvider, name, instructions: `.agents/${name}/AGENT.md` });
        return { ok: true, id: record.id, name: record.name };
    } catch (error) {
        return { ok: false, reason: `the agent was not created: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
        inFlight.delete(key);
    }
}
