import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { moreGenieTools, type ApprovalGate, type MoreToolsDeps, type TerminalsPort } from '../src/main/mcp-tools-more.js';
import type { Caller, Registration, ToolContext } from '../src/main/mcp-tools.js';

/**
 * TWO MORE GENIE TOOLS on prism's contract: `knowledge` (the §6.7 graph, scoped to the caller's
 * workspace by default, `all` always allowed) and `manageTerminals` (§6.5: create and write are
 * APPROVAL-GATED; a multi-line write is wrapped in bracketed paste with Enter delivered separately;
 * a read says `dropped: true` when the scrollback was cut, rather than presenting a cut buffer as
 * the whole).
 */

let dir: string;
let knowledge: KnowledgeStore;
let tools: Registration[];
let approvals: Array<{ caller: Caller; action: string; detail: string }>;
let verdict: 'allowed' | 'denied';
let terminals: ReturnType<typeof fakeTerminals>;

const atlas: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
const ctx = (tool: string): ToolContext => ({ server: 'genie', tool, headers: {} });

function fakeTerminals(cap: number) {
    const list: Array<{ id: string; workspaceId: string; cwd: string; command?: string }> = [];
    const writes: Array<[string, string]> = [];
    const scroll: Record<string, string> = {};
    let n = 0;
    const port: TerminalsPort = {
        list: () => list.map((t) => ({ id: t.id, workspaceId: t.workspaceId, cwd: t.cwd, pid: 100, shell: 'bash' })),
        open: (o) => { const id = `term_${++n}`; list.push({ id, workspaceId: o.workspaceId, cwd: o.cwd ?? '/w', ...(o.command ? { command: o.command } : {}) }); return { id, pid: 100 + n, shell: 'bash', scrollback: '' }; },
        write: (id, data) => { if (!list.some((t) => t.id === id)) return false; writes.push([id, data]); return true; },
        scrollback: (id) => scroll[id],
        scrollbackCap: cap,
    };
    return { port, list, writes, scroll };
}

async function call(name: string, args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === name)!;
    const r = await reg.handler(args, ctx(name));
    return { ...r, json: JSON.parse(r.text) as Record<string, unknown> };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-more-'));
    knowledge = KnowledgeStore.open(dir);
    approvals = [];
    verdict = 'allowed';
    terminals = fakeTerminals(50);
    const approve: ApprovalGate = async (caller, action, detail) => { approvals.push({ caller, action, detail }); return verdict; };
    const deps: MoreToolsDeps = {
        knowledge,
        terminals: terminals.port,
        approve,
        resolveCaller: (id) => (id === 't-atlas' ? atlas : null),
    };
    tools = moreGenieTools(deps);
});

afterEach(async () => {
    knowledge.close();
    await rm(dir, { recursive: true, force: true });
});

describe('registrations', () => {
    it('are knowledge and manageTerminals, both taking terminalId without requiring it (a session is known by its header)', () => {
        expect(tools.map((t) => t.definition.name).sort()).toEqual(['knowledge', 'manageTerminals']);
        for (const t of tools) {
            const schema = t.definition.inputSchema as { required: string[]; properties: Record<string, unknown> };
            expect(schema.properties.terminalId).toBeDefined();
            expect(schema.required).not.toContain('terminalId');
        }
    });
});

describe('knowledge', () => {
    it('add files into the caller’s workspace by default, system when asked; search covers system + the workspace by default and everything with `all`', async () => {
        const a = await call('knowledge', { terminalId: 't-atlas', action: 'add', title: 'Herd phar', body: 'composer is a phar under Herd' });
        expect(a.isError).toBe(false);
        expect(knowledge.get(String(a.json.id))!.scope).toEqual({ kind: 'workspace', id: 'tynn' });
        const s = await call('knowledge', { terminalId: 't-atlas', action: 'add', title: 'Owner prefers Fancy', body: 'never hand-roll', class: 'profile', scope: 'system' });
        expect(knowledge.get(String(s.json.id))!.scope).toEqual({ kind: 'system' });
        knowledge.add({ title: 'Fancy caddy', body: 'fancy caddy note', scope: { kind: 'workspace', id: 'fancy' }, source: 'agent' });

        const mine = await call('knowledge', { terminalId: 't-atlas', action: 'search', query: 'fancy' });
        expect((mine.json.hits as Array<{ title: string }>).map((h) => h.title)).toEqual(['Owner prefers Fancy']);
        const all = await call('knowledge', { terminalId: 't-atlas', action: 'search', query: 'fancy', scope: 'all' });
        expect((all.json.hits as unknown[]).length).toBe(2);
    });

    it('get, list and link work through the tool; an unknown id is an error naming it', async () => {
        const a = await call('knowledge', { terminalId: 't-atlas', action: 'add', title: 'A', body: 'see [[B]]' });
        const b = await call('knowledge', { terminalId: 't-atlas', action: 'add', title: 'B', body: '' });
        const got = await call('knowledge', { terminalId: 't-atlas', action: 'get', id: String(a.json.id) });
        expect((got.json.node as { links: string[] }).links).toEqual([b.json.id]);
        const listed = await call('knowledge', { terminalId: 't-atlas', action: 'list', limit: 1 });
        expect((listed.json.nodes as unknown[]).length).toBe(1);
        expect(listed.json.nextCursor).not.toBeNull();
        const linked = await call('knowledge', { terminalId: 't-atlas', action: 'link', from: String(b.json.id), to: 'A' });
        expect(linked.isError).toBe(false);
        const missing = await call('knowledge', { terminalId: 't-atlas', action: 'get', id: 'kn_nope' });
        expect(missing.isError).toBe(true);
        expect(missing.text).toContain('kn_nope');
    });
});

describe('manageTerminals', () => {
    it('list shows the caller’s workspace terminals only', async () => {
        terminals.port.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        terminals.port.open({ workspaceId: 'fancy', cwd: '/w/fancy' });
        const r = await call('manageTerminals', { terminalId: 't-atlas', action: 'list' });
        expect((r.json.terminals as Array<{ workspaceId: string }>).map((t) => t.workspaceId)).toEqual(['tynn']);
    });

    it('create is APPROVAL-GATED: allowed → opened in the caller’s workspace; denied → nothing opened, error says so', async () => {
        const ok = await call('manageTerminals', { terminalId: 't-atlas', action: 'create', command: 'npm test' });
        expect(ok.isError).toBe(false);
        expect(approvals).toEqual([{ caller: atlas, action: 'create', detail: 'npm test' }]);
        expect(terminals.list).toEqual([{ id: 'term_1', workspaceId: 'tynn', cwd: '/w/tynn', command: 'npm test' }]);

        verdict = 'denied';
        const no = await call('manageTerminals', { terminalId: 't-atlas', action: 'create', command: 'rm -rf /' });
        expect(no.isError).toBe(true);
        expect(no.text).toMatch(/denied/);
        expect(terminals.list).toHaveLength(1);
    });

    it('write is APPROVAL-GATED; a single line goes as typed plus Enter; a MULTI-LINE write is bracketed-paste wrapped with Enter delivered SEPARATELY', async () => {
        terminals.port.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        await call('manageTerminals', { terminalId: 't-atlas', action: 'write', id: 'term_1', text: 'ls -la' });
        expect(terminals.writes).toEqual([['term_1', 'ls -la'], ['term_1', '\r']]);
        terminals.writes.length = 0;
        await call('manageTerminals', { terminalId: 't-atlas', action: 'write', id: 'term_1', text: 'line one\nline two' });
        expect(terminals.writes).toEqual([['term_1', '\x1b[200~line one\nline two\x1b[201~'], ['term_1', '\r']]);
        expect(approvals.map((a) => a.action)).toEqual(['write', 'write']);
        // No Enter when asked to hold it.
        terminals.writes.length = 0;
        await call('manageTerminals', { terminalId: 't-atlas', action: 'write', id: 'term_1', text: 'partial', enter: false });
        expect(terminals.writes).toEqual([['term_1', 'partial']]);
    });

    it('write to another workspace’s terminal, or an unknown one, is refused — and never asks for approval', async () => {
        terminals.port.open({ workspaceId: 'fancy', cwd: '/w/fancy' });
        const r = await call('manageTerminals', { terminalId: 't-atlas', action: 'write', id: 'term_1', text: 'x' });
        expect(r.isError).toBe(true);
        expect(approvals).toEqual([]);
        const nope = await call('manageTerminals', { terminalId: 't-atlas', action: 'read', id: 'term_nope' });
        expect(nope.isError).toBe(true);
    });

    it('read returns the scrollback and says `dropped: true` when it was cut at the engine’s cap — never a cut buffer presented whole', async () => {
        terminals.port.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        terminals.scroll.term_1 = 'short output';
        const whole = await call('manageTerminals', { terminalId: 't-atlas', action: 'read', id: 'term_1' });
        expect(whole.json).toMatchObject({ text: 'short output', dropped: false });
        terminals.scroll.term_1 = 'x'.repeat(50);
        const cut = await call('manageTerminals', { terminalId: 't-atlas', action: 'read', id: 'term_1' });
        expect(cut.json).toMatchObject({ dropped: true });
        expect(String(cut.json.text)).toHaveLength(50);
    });
});
