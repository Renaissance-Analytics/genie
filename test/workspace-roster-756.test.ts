import { describe, expect, it } from 'vitest';
import { importedAgents } from '../src/core/agent-adoption.js';
import { agentConfigsOf } from '../src/core/agent-config.js';
import { adoptAgent, type AgentAdoptionPorts } from '../src/main/agent-adoption-host.js';
import { restoreWorkspaceSettings, type RestorePorts } from '../src/main/workspace-restore-host.js';

/**
 * A CLONE'S ROSTER AND WORKSPACE SETTINGS (Tynn #756, PR8). The agents a clone came with are OFFERED, never automatic (Genie 1's rule:
 * `git pull` must not be a way to gain agents), and when the person adopts one it brings what project.json says of it: how it hears
 * IssueWatch, and whether it is the workspace's default agent. What project.json says of the WORKSPACE (caps, limits, the default
 * agent by name, the env file, MCP servers off) is applied only where the clone has not already chosen: never over a choice, never
 * turning anything ON, and never a safety setting or an agent's capability grant. Fixtures are invented names.
 */

const V5 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/project.schema.json';
const ROOT = '/w/acme.agi';
const watch = { delivery: 'push' as const, kinds: ['issue.new' as const, 'ci.failed' as const] };

describe('the agents a clone came with', () => {
    it('are offered with the IssueWatch their config says, and nothing else of a grant', () => {
        const configs = agentConfigsOf({ agents: { lift: { purpose: 'Builds.', issueWatch: watch, autoApprove: true, permissions: { write: true }, manageTabs: true, drivePages: true, mcpOff: ['slack'] } } });
        const [lift] = importedAgents({ files: [{ folder: 'lift' }], registered: [], configs });
        expect(lift?.issueWatch).toEqual(watch);
        expect(Object.keys(lift!).sort()).toEqual(['instructions', 'issueWatch', 'name', 'provider', 'refusal']);
    });

    it('CONTROL: an agent with no IssueWatch in its config is offered without one, and with no grant either', () => {
        const [scout] = importedAgents({ files: [{ folder: 'scout' }], registered: [], configs: agentConfigsOf({ agents: { scout: { purpose: 'Scouts.', autoApprove: true } } }) });
        expect(Object.keys(scout!).sort()).toEqual(['instructions', 'name', 'provider', 'refusal']);
    });
});

function adoption(manifest: Record<string, unknown>, over: { defaultAgent?: string | null } = {}) {
    const files: Record<string, string> = {
        [`${ROOT}/project.json`]: `${JSON.stringify({ $schema: V5, name: 'acme', ...manifest }, null, 2)}\n`,
        [`${ROOT}/.agents/lift/AGENT.md`]: 'Builds.\n',
        [`${ROOT}/.agents/scout/AGENT.md`]: 'Scouts.\n',
    };
    const registered: { workspaceId: string; provider: string; name: string; instructions: string }[] = [];
    const watches: [string, unknown][] = [];
    const defaults: [string, string][] = [];
    const ports: AgentAdoptionPorts = {
        workspace: (id) => (id === 'acme' ? { id, path: ROOT } : null),
        agentsOf: () => [],
        listDirs: async () => ['lift', 'scout'],
        readText: async (p) => files[p.replace(/\\/g, '/')] ?? null,
        writeTextAtomic: async () => {},
        register: async (input) => { registered.push(input); return { id: `agent_${input.name}`, name: input.name }; },
        setIssueWatch: async (id, setting) => { watches.push([id, setting]); },
        defaultAgentOf: () => over.defaultAgent ?? null,
        setDefaultAgent: async (workspaceId, id) => { defaults.push([workspaceId, id]); },
    };
    return { ports, registered, watches, defaults };
}
const config = { lift: { purpose: 'Builds.', issueWatch: watch }, scout: { purpose: 'Scouts.' } };

describe('adopting one', () => {
    it('brings its IssueWatch, and registers it with exactly what a registration takes: no grant of any kind', async () => {
        const f = adoption({ agents: { ...config, lift: { ...config.lift, autoApprove: true, permissions: { write: true } } } });
        expect(await adoptAgent(f.ports, 'acme', 'lift')).toMatchObject({ ok: true, id: 'agent_lift' });
        expect(f.watches).toEqual([['agent_lift', watch]]);
        expect(Object.keys(f.registered[0]!).sort()).toEqual(['instructions', 'name', 'provider', 'workspaceId']);
    });

    it('is the workspace’s default agent when project.json names it and the workspace has none', async () => {
        const f = adoption({ agents: config, workspace: { defaultAgent: 'lift' } });
        await adoptAgent(f.ports, 'acme', 'lift');
        expect(f.defaults).toEqual([['acme', 'agent_lift']]);
    });

    it('CONTROL: another agent is not made the default; and a workspace that already has one keeps it', async () => {
        const other = adoption({ agents: config, workspace: { defaultAgent: 'lift' } });
        await adoptAgent(other.ports, 'acme', 'scout');
        expect(other.defaults).toEqual([]);
        const had = adoption({ agents: config, workspace: { defaultAgent: 'lift' } }, { defaultAgent: 'agent_cass' });
        await adoptAgent(had.ports, 'acme', 'lift');
        expect(had.defaults).toEqual([]);
    });

    it('CONTROL: an agent with no IssueWatch sets none', async () => {
        const f = adoption({ agents: config });
        await adoptAgent(f.ports, 'acme', 'scout');
        expect(f.watches).toEqual([]);
    });
});

function restore(over: { overridden?: Record<string, unknown>; agents?: { id: string; name: string }[]; defaultAgent?: string | null; envFile?: string | null; defaultEnvFile?: string; mcpOff?: string[] } = {}) {
    const calls: string[] = [];
    const ports: RestorePorts = {
        agentsOf: () => over.agents ?? [],
        overridden: () => over.overridden ?? {},
        setSetting: async (_ws, key, value) => { calls.push(`setting ${key}=${value}`); },
        defaultAgentOf: () => over.defaultAgent ?? null,
        setDefaultAgent: async (_ws, id) => { calls.push(`default ${id}`); },
        envFileOf: () => over.envFile ?? null,
        defaultEnvFile: () => over.defaultEnvFile ?? '.env',
        setEnvFile: async (_ws, file) => { calls.push(`envFile ${file}`); },
        mcpOff: () => over.mcpOff ?? [],
        setMcpServer: async (_ws, name, on) => { calls.push(`mcp ${name}=${on}`); },
    };
    return { ports, calls };
}
const declared = { workspace: { agentCap: 4, limitTerminals: 8, defaultAgent: 'lift', envFile: '.env.local', mcpOff: ['slack', 'notion'] } };

describe('the workspace’s settings on a clone', () => {
    it('apply where the clone has chosen nothing: the caps, the default agent by name, the env file, the MCP servers off', async () => {
        const { ports, calls } = restore({ agents: [{ id: 'agent_1', name: 'Lift' }] });
        const out = await restoreWorkspaceSettings(declared, 'acme', ports);
        expect(calls).toEqual(['setting agent_cap=4', 'setting limit_terminals=8', 'default agent_1', 'envFile .env.local', 'mcp slack=false', 'mcp notion=false']);
        expect(out.applied).toEqual(['agent_cap', 'limit_terminals', 'defaultAgent', 'envFile', 'mcpOff:slack', 'mcpOff:notion']);
    });

    it('never over a choice the clone already made: an overridden setting, a default agent, an env file the person set, a server already off', async () => {
        const { ports, calls } = restore({ overridden: { agent_cap: '2' }, agents: [{ id: 'agent_1', name: 'lift' }], defaultAgent: 'agent_9', envFile: '.env.mine', mcpOff: ['slack'] });
        const out = await restoreWorkspaceSettings(declared, 'acme', ports);
        expect(calls).toEqual(['setting limit_terminals=8', 'mcp notion=false']);
        expect(out.kept).toEqual(['agent_cap', 'defaultAgent', 'envFile', 'mcpOff:slack']);
    });

    it('the env file the host stamped as its own default is replaced by the project’s; it is a default, not a choice', async () => {
        const { ports, calls } = restore({ envFile: '.env', defaultEnvFile: '.env' });
        await restoreWorkspaceSettings({ workspace: { envFile: '.env.local' } }, 'acme', ports);
        expect(calls).toEqual(['envFile .env.local']);
    });

    it('a default agent that is not registered here yet waits, and is said', async () => {
        const { ports, calls } = restore();
        const out = await restoreWorkspaceSettings({ workspace: { defaultAgent: 'lift' } }, 'acme', ports);
        expect(calls).toEqual([]);
        expect(out.waiting).toEqual(['defaultAgent']);
    });

    it('never turns a server ON, and never applies a safety setting or a grant someone put in the file: each is ignored and named', async () => {
        const { ports, calls } = restore();
        const out = await restoreWorkspaceSettings({ workspace: { approval_gates: 'none', approvalGates: 'none', appInbox: true, playwright_server: true, autoApprove: true, permissions: {}, path: '/x', agentCap: 4 } }, 'acme', ports);
        expect(calls).toEqual(['setting agent_cap=4']);
        expect(out.ignored.sort()).toEqual(['appInbox', 'approvalGates', 'approval_gates', 'autoApprove', 'path', 'permissions', 'playwright_server']);
        expect(calls.some((c) => c.endsWith('=true'))).toBe(false);
    });

    it('an env file that is not a plain file name is ignored, and said, not written', async () => {
        const { ports, calls } = restore();
        const out = await restoreWorkspaceSettings({ workspace: { envFile: 'sub/.env' } }, 'acme', ports);
        expect(calls).toEqual([]);
        expect(out.ignored).toEqual(['envFile']);
    });

    it('CONTROL: a project.json with no workspace object changes nothing', async () => {
        const { ports, calls } = restore();
        for (const manifest of [{}, { workspace: null }, { workspace: [] }, null, 'x']) {
            expect(await restoreWorkspaceSettings(manifest, 'acme', ports)).toEqual({ applied: [], kept: [], waiting: [], ignored: [] });
        }
        expect(calls).toEqual([]);
    });
});
