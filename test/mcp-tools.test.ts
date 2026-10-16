import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolDefinition, type JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller, type GenieToolsDeps, type Registration, type ToolContext } from '../src/main/mcp-tools.js';

/**
 * GENIE'S MCP TOOLS — the handlers behind imDone, ForceTheQuestion, agentinbox, lists and
 * thumbsUp, built to the contract agreed with prism on prism-mcp-ts#1:
 *
 *     server.register(new ToolDefinition(name, description, inputSchema, title, annotations), handler)
 *     handler(args: JsonObject, { server, tool, headers }) → McpToolResult { text, isError }
 *
 * No transport here. `@particle-academy/prism-mcp-server` is being built by prism; the day it
 * lands these registrations are what Genie hands it. Every test calls a handler the way the
 * server will, and reads `text` as JSON the way a client will.
 */

let dir: string;
let inbox: InboxStore;
let attention: AttentionStore;
let tools: Registration[];
let glowed: string[];
let thumbs: Array<{ caller: Caller; reason: string }>;
let userActive = true;

const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
const kai = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'kai' });
const reviewA = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'review' });
const reviewB = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'codex', name: 'review', accessScope: 'all' });
const hidden = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'hidden' });
const roster: AgentRecord[] = [atlas, kai, reviewA, reviewB, hidden];

const terminals: Record<string, Caller> = {};
const ctx = (tool: string, headers: Record<string, string> = {}): ToolContext => ({ server: 'genie', tool, headers });

async function call(name: string, args: JsonObject, headers?: Record<string, string>) {
    const reg = tools.find((t) => t.definition.name === name);
    if (!reg) throw new Error(`no tool ${name}`);
    const result = await reg.handler(args, ctx(name, headers));
    return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-tools-'));
    inbox = await InboxStore.open(dir);
    attention = await AttentionStore.open(dir, inbox);
    glowed = [];
    thumbs = [];
    userActive = true;
    terminals['t-atlas'] = { agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', workspacePath: join(dir, 'ws-tynn') };
    terminals['t-kai'] = { agentId: kai.id, agentName: 'kai', workspaceId: 'tynn', workspacePath: join(dir, 'ws-tynn') };
    terminals['t-hidden'] = { agentId: hidden.id, agentName: 'hidden', workspaceId: 'fancy', workspacePath: join(dir, 'ws-fancy') };
    const deps: GenieToolsDeps = {
        inbox,
        attention,
        roster: () => roster,
        resolveCaller: (terminalId) => terminals[terminalId] ?? null,
        workspaceSetting: (workspaceId) => (workspaceId === 'fancy' ? { scope: 'all' } : { scope: 'self' }),
        userActive: () => userActive,
        glow: (terminalId) => { glowed.push(terminalId); return true; },
        thumbsUp: (caller, reason) => { thumbs.push({ caller, reason }); },
    };
    tools = genieTools(deps);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('the registrations', () => {
    it('are five ToolDefinitions with the names the protocol uses, each with a stable digest', () => {
        expect(tools.map((t) => t.definition.name).sort()).toEqual(['ForceTheQuestion', 'agentinbox', 'imDone', 'lists', 'thumbsUp']);
        // COUNTED: five definitions, five digests, all distinct. A digest is a pin's material.
        for (const t of tools) expect(t.definition).toBeInstanceOf(ToolDefinition);
        expect(new Set(tools.map((t) => t.definition.digest())).size).toBe(5);
        expect(tools.find((t) => t.definition.name === 'imDone')!.definition.digest()).toBe(genieTools({} as GenieToolsDeps).find((t) => t.definition.name === 'imDone')!.definition.digest());
    });

    it('every tool TAKES terminalId and none REQUIRES it (a session is known by its header; terminal-id-optional.test) — and Genie still refuses to guess', async () => {
        for (const t of tools) {
            const schema = t.definition.inputSchema as { required?: string[]; properties: Record<string, unknown> };
            expect(schema.required ?? []).not.toContain('terminalId');
            expect(schema.properties.terminalId).toBeDefined();
        }
        const r = await call('imDone', {});
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/terminalId/);
    });

    it('an unknown terminalId is an error naming it, never a guess', async () => {
        const r = await call('lists', { terminalId: 't-ghost', action: 'show' });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/t-ghost/);
    });

    it('a MIRRORED terminalId arrives as the Mcp-Param header and is honoured', async () => {
        // prism-mcp's `x-mcp-header` moves an argument into `Mcp-Param-<name>`; prism hands the handler every
        // `Mcp-Param-*` header unprefixed and lower-cased (README), so the handler sees `terminalid`.
        const def = tools.find((t) => t.definition.name === 'lists')!.definition;
        const prop = (def.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties.terminalId!;
        expect(prop['x-mcp-header']).toBe('terminalId'); // the header NAME (spec); an object here made Claude drop the tool

        const r = await call('lists', { action: 'show' }, { terminalid: 't-atlas' });
        expect(r.isError).toBe(false);
        expect(r.json).toMatchObject({ agent: [], user: [] });
    });
});

describe('imDone', () => {
    it('glows the terminal, files the handoff, and says both landed', async () => {
        const r = await call('imDone', { terminalId: 't-atlas', handoff: 'stopped at step 4' });
        expect(r.isError).toBe(false);
        expect(glowed).toEqual(['t-atlas']);
        expect(r.json).toMatchObject({ ok: true, glowed: true, handoff: { saved: true } });
        const path = (r.json.handoff as { path: string }).path;
        expect((await readFile(path)).toString()).toContain('stopped at step 4');
    });

    it('with no handoff, says so rather than claiming one landed', async () => {
        const r = await call('imDone', { terminalId: 't-atlas' });
        expect(r.isError).toBe(false);
        expect(r.json.handoff).toEqual({ saved: false, reason: 'no handoff was passed' });
    });
});

describe('ForceTheQuestion', () => {
    const questions = [{ header: 'Engine', question: 'Which engine?', options: [{ label: 'a' }, { label: 'b' }] }];

    it('returns at once with the id, whether the user is active, and never a blocking wait', async () => {
        userActive = false;
        const r = await call('ForceTheQuestion', { terminalId: 't-atlas', questions });
        expect(r.isError).toBe(false);
        expect(r.json).toMatchObject({ ok: true, userActive: false, rejoined: false });
        expect(String(r.json.questionId)).toMatch(/^q_/);
        expect(attention.pending()).toHaveLength(1);
    });

    it('a repeat is rejoined; a malformed ask is an error with the reason and files nothing', async () => {
        const first = await call('ForceTheQuestion', { terminalId: 't-atlas', questions });
        const again = await call('ForceTheQuestion', { terminalId: 't-atlas', questions });
        expect(again.json.questionId).toBe(first.json.questionId);
        expect(again.json.rejoined).toBe(true);

        const bad = await call('ForceTheQuestion', { terminalId: 't-atlas', questions: [] });
        expect(bad.isError).toBe(true);
        expect(bad.text).toMatch(/1.*4 questions/);
        expect(attention.pending()).toHaveLength(1);
    });

    it('the answer reaches the asker through agentinbox receive', async () => {
        const asked = await call('ForceTheQuestion', { terminalId: 't-atlas', questions });
        await attention.answer(String(asked.json.questionId), { selections: [['b']], note: 'b, because' });
        const got = await call('agentinbox', { terminalId: 't-atlas', action: 'receive' });
        const messages = got.json.messages as Array<{ from: string; text: string }>;
        expect(messages).toHaveLength(1);
        expect(messages[0]!.from).toBe(HUMAN);
        expect(messages[0]!.text).toContain('b, because');
    });
});

describe('agentinbox', () => {
    it('list shows the peers the caller may reach, with the addresses that resolve', async () => {
        const r = await call('agentinbox', { terminalId: 't-atlas', action: 'list' });
        expect(r.isError).toBe(false);
        const peers = r.json.peers as Array<{ address: string; reachable: boolean }>;
        // kai (same workspace), reviewA (same workspace), reviewB (fancy, scope all + workspace all);
        // hidden is self-scoped in another workspace → listed as not reachable; atlas itself is not listed.
        const byAddress = Object.fromEntries(peers.map((p) => [p.address, p.reachable]));
        expect(byAddress).toEqual({
            'claude:kai': true,
            'tynn:codex:review': true,
            'fancy:codex:review': true,
            'claude:hidden': false,
        });
    });

    it('send resolves an address, refuses an ambiguous one naming BOTH forms, and refuses the unreachable', async () => {
        const ok = await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'claude:kai', text: 'hi kai' });
        expect(ok.isError).toBe(false);
        expect(ok.json).toMatchObject({ ok: true, delivered: 1 });
        expect((await inbox.receive({ participant: kai.id })).messages.map((m) => m.text)).toEqual(['hi kai']);

        const ambiguous = await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'codex:review', text: 'x' });
        expect(ambiguous.isError).toBe(true);
        expect(ambiguous.text).toContain('tynn:codex:review');
        expect(ambiguous.text).toContain('fancy:codex:review');

        const unreachable = await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'claude:hidden', text: 'x' });
        expect(unreachable.isError).toBe(true);
        expect(unreachable.text).toMatch(/not reachable/);
        expect((await inbox.receive({ participant: hidden.id })).messages).toEqual([]);

        const nobody = await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'claude:ghost', text: 'x' });
        expect(nobody.isError).toBe(true);
        expect(nobody.text).toMatch(/claude:ghost/);
    });

    it('the human is addressable, and the human’s mail comes from `human`', async () => {
        const r = await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'human', text: 'for you' });
        expect(r.isError).toBe(false);
        expect((await inbox.receive({ participant: HUMAN })).messages.map((m) => m.text)).toEqual(['for you']);
    });

    it('receive long-polls and is woken by a send; acknowledge:false leaves it unread; cursor rewinds', async () => {
        const waiting = call('agentinbox', { terminalId: 't-kai', action: 'receive', wait: true, timeoutMs: 5000 });
        setTimeout(() => void call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'claude:kai', text: 'wake' }), 30);
        const got = await waiting;
        expect((got.json.messages as unknown[]).length).toBe(1);
        expect(inbox.unreadCount(kai.id)).toBe(0);

        const peek = await call('agentinbox', { terminalId: 't-kai', action: 'receive', cursor: 0, acknowledge: false });
        expect((peek.json.messages as unknown[]).length).toBe(1);
        expect(got.json.cursor).toBe(peek.json.cursor);
    });

    it('receipts report whether what the caller sent was read', async () => {
        await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'claude:kai', text: 'read me' });
        const before = await call('agentinbox', { terminalId: 't-atlas', action: 'receipts' });
        expect((before.json.receipts as Array<{ readAt: string | null }>)[0]!.readAt).toBeNull();
        await call('agentinbox', { terminalId: 't-kai', action: 'receive' });
        const after = await call('agentinbox', { terminalId: 't-atlas', action: 'receipts' });
        expect((after.json.receipts as Array<{ readAt: string | null }>)[0]!.readAt).not.toBeNull();
    });

    it('attachments are byte copies the recipient can save; an executable is refused with the reason', async () => {
        const src = join(dir, 'note.md');
        await writeFile(src, 'bytes');
        const sent = await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'claude:kai', text: 'file', attachments: [src] });
        expect(sent.isError).toBe(false);
        await rm(src);
        const got = await call('agentinbox', { terminalId: 't-kai', action: 'receive' });
        const att = (got.json.messages as Array<{ attachments: Array<{ id: string; name: string }> }>)[0]!.attachments[0]!;
        const saved = await call('agentinbox', { terminalId: 't-kai', action: 'saveAttachment', attachmentId: att.id, path: join(dir, 'out', 'note.md') });
        expect(saved.isError).toBe(false);
        expect((await readFile(join(dir, 'out', 'note.md'))).toString()).toBe('bytes');

        await writeFile(join(dir, 'x.exe'), 'MZ');
        const refused = await call('agentinbox', { terminalId: 't-atlas', action: 'send', to: 'claude:kai', text: 'x', attachments: [join(dir, 'x.exe')] });
        expect(refused.isError).toBe(true);
        expect(refused.text).toMatch(/executable/);
    });

    it('an unknown action is an error naming the actions that exist', async () => {
        const r = await call('agentinbox', { terminalId: 't-atlas', action: 'broadcast' });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/broadcast/);
        expect(r.text).toMatch(/receive/);
    });
});

describe('lists', () => {
    it('add / show / done / clear on the caller’s own list and the shared user list', async () => {
        const a = await call('lists', { terminalId: 't-atlas', action: 'add', list: 'agent', text: 'write the probe' });
        expect(a.isError).toBe(false);
        await call('lists', { terminalId: 't-atlas', action: 'add', list: 'user', text: 'rotate the token' });
        await call('lists', { terminalId: 't-kai', action: 'add', list: 'user', text: 'approve the share' });

        const mine = await call('lists', { terminalId: 't-atlas', action: 'show' });
        expect((mine.json.agent as Array<{ text: string }>).map((i) => i.text)).toEqual(['write the probe']);
        expect((mine.json.user as Array<{ text: string; askedBy: string }>).map((i) => [i.text, i.askedBy])).toEqual([
            ['rotate the token', 'atlas'],
            ['approve the share', 'kai'],
        ]);

        const id = (a.json.item as { id: string }).id;
        await call('lists', { terminalId: 't-atlas', action: 'done', id });
        const after = await call('lists', { terminalId: 't-atlas', action: 'show' });
        expect((after.json.agent as Array<{ done: boolean }>)[0]!.done).toBe(true);

        await call('lists', { terminalId: 't-atlas', action: 'clear', list: 'agent' });
        expect(((await call('lists', { terminalId: 't-atlas', action: 'show' })).json.agent as unknown[])).toEqual([]);
    });

    it('a full list and a question are refusals with the reason, not silent drops', async () => {
        for (let i = 0; i < 5; i++) await call('lists', { terminalId: 't-atlas', action: 'add', list: 'user', text: `u${i}` });
        const full = await call('lists', { terminalId: 't-atlas', action: 'add', list: 'user', text: 'u5' });
        expect(full.isError).toBe(true);
        expect(full.text).toMatch(/5/);
        const q = await call('lists', { terminalId: 't-atlas', action: 'add', list: 'agent', text: 'should I?' });
        expect(q.isError).toBe(true);
        expect(q.text).toMatch(/ForceTheQuestion/);
    });
});

describe('thumbsUp', () => {
    it('records readiness for the caller with its reason', async () => {
        const r = await call('thumbsUp', { terminalId: 't-atlas', reason: 'boot' });
        expect(r.isError).toBe(false);
        expect(thumbs).toEqual([{ caller: terminals['t-atlas'], reason: 'boot' }]);
    });
});
