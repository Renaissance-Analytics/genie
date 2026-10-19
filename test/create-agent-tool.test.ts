import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { agentTools, type AgentToolsDeps } from '../src/main/mcp-tools-agents.js';
import { genieMcpServer, type GenieMcpServer } from '../src/main/mcp-server.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * THE DEFAULT AGENT MAY ASK TO CREATE A WORKSPACE AGENT — AND ONLY IT SEES THE TOOL (the owner, 2026-10-19, FTQ q_09d1f4a0:
 * "an agent can ask to create a new agent … waits in the Deck until you approve"; "If an agent is not the default workspace
 * agent then it cannot create new agents and shouldn't even have the tool in its catalog").
 *
 * `createAgent {name, provider, instructions?}`: registered with prism-mcp-server 0.3.0's per-request `visible` — true only
 * for the session of its workspace's DEFAULT agent; to anyone else it is absent from tools/list and a call fails exactly as
 * an unknown tool's. The default agent's call waits for the PERSON's approval (never auto-approved, whatever the agent's
 * autonomy), then registers the agent in the caller's workspace.
 */

const rec = (id: string, name: string, workspaceId = 'tynn'): AgentRecord => ({ id, name, workspaceId, provider: 'claude', instructions: null, threadId: null, createdAt: '2026-10-19T00:00:00Z', lastUsedAt: null, mode: 'manual', accessScope: 'self' } as AgentRecord);
const CALLERS: Record<string, Caller> = {
    'k-atlas': { agentId: 'a1', agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' } as Caller,
    'k-wren': { agentId: 'a2', agentName: 'wren', workspaceId: 'tynn', workspacePath: '/w/tynn' } as Caller,
};

function harness(over: { verdict?: 'allowed' | 'denied'; defaultAgent?: string | null } = {}) {
    const roster = [rec('a1', 'atlas'), rec('a2', 'wren')];
    const asked: Array<{ caller: string; action: string; detail: string }> = [];
    const registered: Array<{ workspaceId: string; provider: string; name: string; instructions: string | null }> = [];
    const deps: AgentToolsDeps = {
        resolveCaller: (key) => CALLERS[key] ?? null,
        defaultAgentOf: (ws) => (ws === 'tynn' ? (over.defaultAgent === undefined ? 'a1' : over.defaultAgent) : null),
        roster: () => roster,
        approve: async (caller, action, detail) => { asked.push({ caller: caller.agentName, action, detail }); return over.verdict ?? 'allowed'; },
        register: async (input) => { registered.push({ ...input, instructions: input.instructions ?? null }); const r = rec(`new-${registered.length}`, input.name, input.workspaceId); roster.push(r); return r; },
        addressOf: (r) => `${r.workspaceId}:${r.provider}:${r.name}`,
    };
    const [tool] = agentTools(deps);
    const call = (key: string, args: Record<string, unknown>) => tool!.handler(args as never, { headers: { 'genie-session': key } } as never);
    return { tool: tool!, deps, asked, registered, call };
}
const parse = (r: { text: string }) => JSON.parse(r.text) as Record<string, unknown>;

describe('who sees createAgent', () => {
    it('only the session of its workspace’s DEFAULT agent; a helper, an unknown session, or none designated: no', async () => {
        const h = harness();
        expect(h.tool.definition.name).toBe('createAgent');
        expect(await h.tool.visible!({ headers: { 'mcp-param-genie-session': 'k-atlas' } })).toBe(true);
        expect(await h.tool.visible!({ headers: { 'mcp-param-genie-session': 'k-wren' } })).toBe(false);
        expect(await h.tool.visible!({ headers: { 'mcp-param-genie-session': 'k-nobody' } })).toBe(false);
        expect(await h.tool.visible!({ headers: {} })).toBe(false);
        expect(await harness({ defaultAgent: null }).tool.visible!({ headers: { 'mcp-param-genie-session': 'k-atlas' } })).toBe(false);
    });
});

describe('what createAgent does', () => {
    it('asks the PERSON (action agents.create, saying who, what and where), then registers it in the caller’s workspace', async () => {
        const h = harness();
        const out = parse(await h.call('k-atlas', { name: 'scout', provider: 'codex', instructions: 'Review PRs.' }));
        expect(h.asked).toEqual([{ caller: 'atlas', action: 'agents.create', detail: 'Create a new agent “scout” (codex) in tynn — instructions: Review PRs.' }]);
        expect(h.registered).toEqual([{ workspaceId: 'tynn', provider: 'codex', name: 'scout', instructions: 'Review PRs.' }]);
        expect(out).toMatchObject({ ok: true, name: 'scout', address: 'tynn:claude:scout' });
    });

    it('the person declines: nothing is created, and the agent is told', async () => {
        const h = harness({ verdict: 'denied' });
        expect(parse(await h.call('k-atlas', { name: 'scout', provider: 'codex' }))).toEqual({ ok: false, error: 'The person declined: no agent was created.' });
        expect(h.registered).toEqual([]);
    });

    it('a name already in the workspace is refused BEFORE the person is asked; a bad provider too', async () => {
        const h = harness();
        expect(parse(await h.call('k-atlas', { name: 'wren', provider: 'codex' }))).toMatchObject({ ok: false });
        expect(parse(await h.call('k-atlas', { name: 'scout', provider: 'gpt' }))).toMatchObject({ ok: false });
        expect(h.asked).toEqual([]);
        expect(h.registered).toEqual([]);
    });

    it('CONTROL: a non-default agent that calls it anyway (the handler’s own check) is refused, asks nobody, makes nothing', async () => {
        const h = harness();
        expect(parse(await h.call('k-wren', { name: 'scout', provider: 'codex' }))).toMatchObject({ ok: false });
        expect(h.asked).toEqual([]);
        expect(h.registered).toEqual([]);
    });
});

describe('never auto-approved', () => {
    it('an agent set to auto-approve still waits for the person on agents.create — and its other actions still pass (CONTROL)', async () => {
        const queue = new ApprovalQueue({ now: () => 1, autoApproved: () => true });
        const caller = CALLERS['k-atlas']!;
        expect(await queue.gate(caller, 'processes.add', 'x')).toBe('allowed');
        let settled = false;
        void queue.gate(caller, 'agents.create', 'Create a new agent').then(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 0));
        expect(settled).toBe(false);
        expect(queue.deckItems().map((d) => d.title ?? '')).toHaveLength(1);
    });
});

describe('over the real server (prism-mcp-server 0.3.0)', () => {
    let server: GenieMcpServer | null = null;
    afterEach(async () => { await server?.stop(); server = null; });
    const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

    it('tools/list as the default agent names createAgent; as a helper it is absent (COUNTED)', async () => {
        const h = harness();
        server = genieMcpServer({ registrations: agentTools(h.deps), port: 0 });
        const { url, token } = await server.start();
        const list = async (key: string) => {
            const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'Mcp-Param-Genie-Session': key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }) });
            return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
        };
        expect(await list('k-atlas')).toEqual(['createAgent']);
        expect(await list('k-wren')).toEqual([]);
    });
});
