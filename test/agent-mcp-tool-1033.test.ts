import { describe, expect, it } from 'vitest';
import { APP_MCP_WORDS, type AppMcpEntry } from '../src/core/app-mcp.js';
import type { AgentRecord } from '../src/core/identity.js';
import { PERSON_ONLY_TOOLS } from '../src/core/gapp-grants.js';
import { PERSON_ONLY_ACTIONS } from '../src/main/approval-queue.js';
import { AGENT_MCP_ACTION, AGENT_MCP_WORDS, agentMcpTools, type AgentMcpToolDeps } from '../src/main/mcp-tools-agent-mcp.js';
import { HOST_NATIVE_TOOLS } from '../src/main/mcp-host-tools.js';
import { BUILTIN_TOOLS } from '../src/main/genie-catalog.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * THE DEFAULT AGENT MANAGES THE MCP SERVERS OF THE AGENTS IN ITS WORKSPACE (Tynn #1033; the owner, 2026-11-22: "workspace
 * default agents need to be able to edit the mcp config for any of the other agents they spawn").
 *
 * `agentMcp {action, agent, …, why}`: list, add, remove, on, off. Only the workspace's default agent sees it or may call
 * it, and only on another agent of its own workspace. An add, or a server switched on, waits for the PERSON in the Deck
 * (never auto-approved, as createAgent). Every change says why, and the answer says it applies at that agent's next
 * session start.
 */

const rec = (id: string, name: string, workspaceId = 'tynn', extra: Partial<AgentRecord> = {}): AgentRecord => ({ id, name, workspaceId, provider: 'claude', instructions: null, threadId: null, createdAt: '2026-11-22T00:00:00Z', lastUsedAt: null, mode: 'manual', accessScope: 'self', ...extra } as AgentRecord);
const CALLERS: Record<string, Caller> = {
    'k-boss': { agentId: 'a1', agentName: 'boss', workspaceId: 'tynn', workspacePath: '/w/tynn' } as Caller,
    'k-wren': { agentId: 'a2', agentName: 'wren', workspaceId: 'tynn', workspacePath: '/w/tynn' } as Caller,
};
const SITES = [{ id: 's1', name: 'shop', host: 'shop.gen' }];

function harness(over: { verdict?: 'allowed' | 'denied' } = {}) {
    const roster = [rec('a1', 'boss'), rec('a2', 'wren'), rec('a3', 'scout'), rec('b1', 'far', 'other')];
    const asked: Array<{ caller: string; action: string; detail: string }> = [];
    const wrote: Array<{ agentId: string; list: readonly AppMcpEntry[] }> = [];
    const switched: Array<{ agentId: string; name: string; on: boolean }> = [];
    const deps: AgentMcpToolDeps = {
        resolveCaller: (key) => CALLERS[key] ?? null,
        roster: () => roster,
        defaultAgentOf: (ws) => (ws === 'tynn' ? 'a1' : null),
        approve: async (caller, action, detail) => { asked.push({ caller: caller.agentName, action, detail }); return over.verdict ?? 'allowed'; },
        sites: () => SITES,
        candidates: () => [{ kind: 'site', name: 'shop', site: 's1', label: 'shop.gen', url: 'https://shop.gen/mcp', added: false }],
        workspaceMcpOff: () => [],
        setAppMcp: async (agentId, list) => {
            wrote.push({ agentId, list });
            const i = roster.findIndex((r) => r.id === agentId);
            roster[i] = { ...roster[i]!, appMcp: list } as AgentRecord;
            return { ok: true };
        },
        setMcpServer: async (agentId, name, on) => { switched.push({ agentId, name, on }); return { ok: true }; },
    };
    const [tool] = agentMcpTools(deps);
    const call = (key: string, args: Record<string, unknown>) => tool!.handler(args as never, { headers: { 'genie-session': key } } as never);
    const visible = (key: string) => tool!.visible!({ headers: { 'genie-session': key } } as never);
    return { tool: tool!, roster, asked, wrote, switched, call, visible };
}
const parse = (r: { text: string }) => JSON.parse(r.text) as Record<string, unknown>;

describe('who has agentMcp', () => {
    it('the workspace’s default agent sees it; another agent does not', () => {
        const h = harness();
        expect(h.tool.definition.name).toBe('agentMcp');
        expect(h.visible('k-boss')).toBe(true);
        expect(h.visible('k-wren')).toBe(false);
        expect(h.visible('k-nobody')).toBe(false);
    });

    it('the handler checks for itself: another agent calling it is refused and nothing is asked or written', async () => {
        const h = harness();
        const out = await h.call('k-wren', { action: 'add', agent: 'scout', site: 'shop', why: 'w' });
        expect(out.isError).toBe(true);
        expect(parse(out).error).toBe(AGENT_MCP_WORDS.defaultOnly);
        expect(h.asked).toEqual([]);
        expect(h.wrote).toEqual([]);
    });

    it('only another agent of its own workspace: itself, an agent elsewhere, or one Genie does not know are refused', async () => {
        const h = harness();
        expect(parse(await h.call('k-boss', { action: 'list', agent: 'boss' })).error).toBe(AGENT_MCP_WORDS.notItself);
        expect(parse(await h.call('k-boss', { action: 'list', agent: 'far' })).error).toBe(AGENT_MCP_WORDS.noAgent('far'));
        expect(parse(await h.call('k-boss', { action: 'list', agent: 'ghost' })).error).toBe(AGENT_MCP_WORDS.noAgent('ghost'));
    });

    it('is the host’s own, never a GApp’s, and in Genie’s catalog; its approval is the person’s alone', () => {
        expect(HOST_NATIVE_TOOLS.has('agentMcp')).toBe(true);
        expect(PERSON_ONLY_TOOLS.has('agentMcp')).toBe(true);
        expect(BUILTIN_TOOLS.map((t) => t.name)).toContain('agentMcp');
        expect(PERSON_ONLY_ACTIONS).toContain(AGENT_MCP_ACTION);
        expect(AGENT_MCP_ACTION).toBe('agents.mcp');
    });
});

describe('what agentMcp does', () => {
    it('list: the agent’s app servers, its switches, and what the workspace offers', async () => {
        const h = harness();
        const out = parse(await h.call('k-boss', { action: 'list', agent: 'scout' }));
        expect(out).toMatchObject({ ok: true, agent: 'scout', appMcp: [], candidates: [{ name: 'shop', url: 'https://shop.gen/mcp' }] });
        expect(Array.isArray(out.servers)).toBe(true);
        expect(h.asked).toEqual([]);
    });

    it('add: asks the PERSON (agents.mcp, saying what, for whom, and why), then writes it; applies at its next session', async () => {
        const h = harness();
        const out = parse(await h.call('k-boss', { action: 'add', agent: 'scout', site: 'shop', why: 'scout tests the shop API' }));
        expect(h.asked).toEqual([{ caller: 'boss', action: 'agents.mcp', detail: 'Give scout the MCP server “shop” (shop.gen/mcp) — why: scout tests the shop API' }]);
        expect(h.wrote).toEqual([{ agentId: 'a3', list: [{ name: 'shop', site: 's1', path: '/mcp' }] }]);
        expect(out).toMatchObject({ ok: true, agent: 'scout', added: 'shop', applies: AGENT_MCP_WORDS.applies('scout'), why: 'scout tests the shop API' });
    });

    it('add declined: nothing is written', async () => {
        const h = harness({ verdict: 'denied' });
        const out = await h.call('k-boss', { action: 'add', agent: 'scout', url: 'http://127.0.0.1:8000/mcp', why: 'w' });
        expect(out.isError).toBe(true);
        expect(parse(out).error).toBe(AGENT_MCP_WORDS.declined);
        expect(h.wrote).toEqual([]);
    });

    it('add refused BEFORE the person is asked: not local, a secret, no why', async () => {
        const h = harness();
        expect(parse(await h.call('k-boss', { action: 'add', agent: 'scout', url: 'https://mcp.example.com/mcp', why: 'w' })).error).toBe(APP_MCP_WORDS.localOnly);
        expect(parse(await h.call('k-boss', { action: 'add', agent: 'scout', site: 'shop', headers: [{ name: 'Authorization', value: 'x' }], why: 'w' })).error).toBe(APP_MCP_WORDS.noSecrets);
        expect(parse(await h.call('k-boss', { action: 'add', agent: 'scout', site: 'shop' })).error).toBe(AGENT_MCP_WORDS.why);
        expect(h.asked).toEqual([]);
        expect(h.wrote).toEqual([]);
    });

    it('on asks the person; off and remove take capability away and do not; each says why', async () => {
        const h = harness();
        await h.call('k-boss', { action: 'add', agent: 'scout', site: 'shop', why: 'w' });
        h.asked.length = 0;
        expect(parse(await h.call('k-boss', { action: 'off', agent: 'scout', name: 'shop', why: 'too much context' }))).toMatchObject({ ok: true, switched: 'shop', on: false });
        expect(h.asked).toEqual([]);
        expect(parse(await h.call('k-boss', { action: 'on', agent: 'scout', name: 'github', why: 'it reviews PRs' }))).toMatchObject({ ok: true, switched: 'github', on: true });
        expect(h.asked).toEqual([{ caller: 'boss', action: 'agents.mcp', detail: 'Switch the MCP server “github” on for scout — why: it reviews PRs' }]);
        expect(h.switched).toEqual([{ agentId: 'a3', name: 'shop', on: false }, { agentId: 'a3', name: 'github', on: true }]);
        expect(parse(await h.call('k-boss', { action: 'remove', agent: 'scout', name: 'shop', why: 'done' }))).toMatchObject({ ok: true, removed: 'shop' });
        expect(h.wrote.at(-1)).toEqual({ agentId: 'a3', list: [] });
        expect(h.asked).toHaveLength(1);
        expect(parse(await h.call('k-boss', { action: 'off', agent: 'scout', name: 'shop' })).error).toBe(AGENT_MCP_WORDS.why);
    });

    it('an unknown action is refused in words', async () => {
        const h = harness();
        expect(parse(await h.call('k-boss', { action: 'nuke', agent: 'scout', why: 'w' })).error).toBe(AGENT_MCP_WORDS.action);
    });
});
