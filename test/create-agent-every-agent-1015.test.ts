import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sharedProtocol } from '../src/core/genie-protocol.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { startHostMcp, type HostMcp, type HostMcpPorts } from '../src/main/host-mcp.js';
import { Store, type WorkspaceRecord } from '../src/main/store.js';

/**
 * AGENTS CAN CREATE AGENTS (Tynn #1015). The owner's beachhead, the ONLY agent of its workspace, had no `createAgent` in
 * its tool list in a genie-host session, while the instructions Genie wrote for it (`.agents/_genie/shared.md`) promised the
 * tool. Measured on the owner's machine (read-only): its workspace's `defaultAgentId` was never recorded, and
 * createAgent was shown only to a workspace's recorded default agent.
 *
 * Now: every agent sees createAgent (the person's approval in the Deck is the gate, unchanged); a call from a genie-host
 * session runs in the host, against its registry, with or without a window; and the instructions list only the tools every
 * agent there is really served. Everything here goes over the host's real HTTP door, with the headers a session sends.
 */

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

let dir: string;
let mcp: HostMcp | null = null;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-create-agent-1015-')); });
afterEach(async () => { await mcp?.stop(); mcp = null; await rm(dir, { recursive: true, force: true }); });

const rec = (workspaceId: string, name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId, provider: 'claude', name });

/** A host with these workspaces and agents ON DISK, as genie-host reads them; approvals answer `verdict`. */
async function host(workspaces: WorkspaceRecord[], agents: AgentRecord[], opts: { verdict?: 'allowed' | 'denied' } = {}) {
    const store = new Store(join(dir, 'home'));
    await store.writeWorkspaces(workspaces);
    await store.writeAgents(agents);
    const registry = new HostRegistry(store);
    await registry.refresh();
    const asked: string[] = [];
    const registered: Array<{ workspaceId: string; name: string; provider: string }> = [];
    const never = () => { throw new Error('not exercised'); };
    const ports: HostMcpPorts = {
        stores: { inbox: never, attention: never, knowledge: never, approvals: { gate: async (_c: unknown, action: string) => { asked.push(action); return opts.verdict ?? 'allowed'; } } } as never,
        settings: { snapshot: () => ({}), snapshotFor: () => ({}) } as never,
        records: () => registry.listAgents(),
        registry,
        probe: (() => null) as never,
        lastRowAt: () => null,
        reportPlan: () => true,
        // NO WINDOW: a genie-host session with Genie's window closed.
        window: { connected: () => false, call: async () => ({ text: 'forwarded to a window', isError: true }) },
        openFileLater: () => {},
        signal: () => {},
        endpointFile: join(dir, 'mcp-endpoint.json'),
        osaDir: join(dir, 'osa'),
        log: () => {},
        // The host's registry registers the agent (genie-host wires phoneRegistry.register, the one writer's).
        registerAgent: async (input) => {
            registered.push({ workspaceId: input.workspaceId, name: input.name, provider: input.provider });
            const record = rec(input.workspaceId, input.name);
            await store.writeAgents([...(await store.readAgents()), record]);
            await registry.refresh();
            return record;
        },
    };
    mcp = startHostMcp(ports);
    await mcp.ready();
    const rpc = async (agent: AgentRecord, method: string, params: Record<string, unknown>) => {
        const [entry] = mcp!.sessionServers(agent) as unknown as Array<{ url: string; headers: Array<{ name: string; value: string }> }>;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        for (const h of entry!.headers) headers[h.name] = h.value;
        const res = await fetch(entry!.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }) });
        return (await res.json()) as { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean }; error?: unknown };
    };
    const toolsOf = async (agent: AgentRecord) => ((await rpc(agent, 'tools/list', {})).result?.tools ?? []).map((t) => t.name);
    const call = async (agent: AgentRecord, name: string, args: Record<string, unknown>) => (await rpc(agent, 'tools/call', { name, arguments: args })).result;
    return { mcp: mcp!, registry, store, asked, registered, toolsOf, call };
}

describe('createAgent is in every agent’s tool list (genie-host session, as the client sees it)', () => {
    it('the ONLY agent of a workspace with no default recorded (the owner’s beachhead) has createAgent', async () => {
        const beachhead = rec('beach', 'beachhead');
        const h = await host([{ id: 'beach', path: join(dir, 'beach') }], [beachhead]);
        expect(await h.toolsOf(beachhead)).toContain('createAgent');
    });

    it('a NON-default agent has it too; CONTROL: the recorded default has it', async () => {
        const atlas = rec('tynn', 'atlas');
        const wren = rec('tynn', 'wren');
        const h = await host([{ id: 'tynn', path: join(dir, 'tynn'), defaultAgentId: atlas.id }], [atlas, wren]);
        expect(await h.toolsOf(atlas)).toContain('createAgent');
        expect(await h.toolsOf(wren)).toContain('createAgent');
    });
});

describe('a createAgent call from a genie-host session runs in the host, with no window', () => {
    it('the person approves: the host’s registry registers it in the caller’s workspace', async () => {
        const wren = rec('tynn', 'wren');
        const atlas = rec('tynn', 'atlas');
        const h = await host([{ id: 'tynn', path: join(dir, 'tynn'), defaultAgentId: atlas.id }], [atlas, wren]);
        const out = await h.call(wren, 'createAgent', { name: 'scout', provider: 'codex' });
        expect(out?.isError).toBe(false);
        expect(JSON.parse(out!.content![0]!.text)).toMatchObject({ ok: true, name: 'scout' });
        expect(h.asked).toEqual(['agents.create']);
        expect(h.registered).toEqual([{ workspaceId: 'tynn', name: 'scout', provider: 'codex' }]);
    });

    it('CONTROL: the person declines: nothing is registered (the gate is unchanged)', async () => {
        const wren = rec('tynn', 'wren');
        const h = await host([{ id: 'tynn', path: join(dir, 'tynn') }], [wren], { verdict: 'denied' });
        const out = await h.call(wren, 'createAgent', { name: 'scout', provider: 'codex' });
        expect(out?.isError).toBe(true);
        expect(h.asked).toEqual(['agents.create']);
        expect(h.registered).toEqual([]);
    });
});

describe('the instructions name only tools the agent is served', () => {
    /** The tool names `shared.md` lists, from the line after "Its tools:". */
    const listedIn = (text: string): string[] => {
        const line = text.split('\n').find((l, i, all) => i > 0 && /Its tools:/.test(all[i - 2] ?? '')) ?? '';
        return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    };

    it('every tool shared.md names is in the tools/list of a plain agent (not the default, no switches on)', async () => {
        const atlas = rec('tynn', 'atlas');
        const wren = rec('tynn', 'wren');
        const h = await host([{ id: 'tynn', path: join(dir, 'tynn'), defaultAgentId: atlas.id }], [atlas, wren]);
        // What genie-host hands the protocol writer (genie-host.ts featureWorkspaceFiles: `mcp.status().tools`).
        const written = sharedProtocol(h.mcp.status().tools);
        const named = listedIn(written);
        // CONTROL: the parse found the list (a gauge that reads nothing proves nothing).
        expect(named).toEqual(expect.arrayContaining(['imDone', 'ForceTheQuestion', 'agentinbox', 'createAgent']));
        const served = await h.toolsOf(wren);
        expect(named.filter((n) => !served.includes(n))).toEqual([]);
    });
});
