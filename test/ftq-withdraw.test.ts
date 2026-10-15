import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deckBand, type DeckItem } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller, type GenieToolsDeps, type Registration } from '../src/main/mcp-tools.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';

/**
 * AN AGENT UPDATES OR CANCELS ITS OWN QUESTION (the owner, 2026-10-15: "agents need to have the ability to update or
 * cancel requests"). ForceTheQuestion takes an optional `action` — `ask` (the default, so every existing call is
 * unchanged), `update`, `cancel` — with the `questionId` the ask returned.
 *
 * - cancel: the question leaves the Deck and the question window (which shows the next), the person is not asked any
 *   more, and NOTHING is mailed — the agent that withdrew it knows.
 * - update: the content (and priority) is replaced in place: same id, same place in the queue, a new revision so a
 *   half-filled form for the old content is dropped; the window showing it shows the new content.
 * - only the asking agent, in its own workspace: another agent, or the same agent from another workspace, is refused
 *   and nothing changes.
 */
const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
const kai = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'kai' });
const roster: AgentRecord[] = [atlas, kai];
const engine = [{ header: 'Engine', question: 'Which engine?', options: [{ label: 'postgres' }, { label: 'sqlite' }] }];
const where = [{ header: 'Where', question: 'Where does it run?', options: [{ label: 'local' }, { label: 'cloud' }] }];

let dir: string;
let clock: number;
let inbox: InboxStore;
let attention: AttentionStore;
let tools: Registration[];
let terminals: Record<string, Caller>;

async function call(args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'ForceTheQuestion')!;
    const result = await reg.handler(args, { server: 'genie', tool: 'ForceTheQuestion', headers: {} });
    return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}
const items = (): DeckItem[] => deckItemsFrom({ questions: attention.pending(), userList: [], unreadDms: [], finished: [], agents: {} });
const mailCount = () => inbox.unread(atlas.id).length + inbox.unread(kai.id).length + inbox.unread(HUMAN).length;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-ftq-withdraw-'));
    clock = Date.parse('2026-10-15T09:00:00.000Z');
    const now = () => new Date(clock++).toISOString();
    inbox = await InboxStore.open(dir, now);
    attention = await AttentionStore.open(dir, inbox, now);
    terminals = {
        't-atlas': { agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', workspacePath: join(dir, 'ws-tynn') },
        't-kai': { agentId: kai.id, agentName: 'kai', workspaceId: 'tynn', workspacePath: join(dir, 'ws-tynn') },
        // The same agent id, calling from ANOTHER workspace.
        't-atlas-fancy': { agentId: atlas.id, agentName: 'atlas', workspaceId: 'fancy', workspacePath: join(dir, 'ws-fancy') },
    };
    const deps: GenieToolsDeps = {
        inbox,
        attention,
        roster: () => roster,
        resolveCaller: (terminalId) => terminals[terminalId] ?? null,
        workspaceSetting: () => ({ scope: 'self' }),
        userActive: () => true,
        glow: () => true,
        thumbsUp: () => {},
    };
    tools = genieTools(deps);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('cancel', () => {
    it('removes EXACTLY that question (counted) and mails nobody', async () => {
        const mine = await call({ terminalId: 't-atlas', questions: engine });
        const other = await call({ terminalId: 't-atlas', questions: where });
        expect(attention.pending()).toHaveLength(2);

        const r = await call({ terminalId: 't-atlas', action: 'cancel', questionId: String(mine.json.questionId) });
        expect(r.isError).toBe(false);
        expect(r.json).toMatchObject({ ok: true, questionId: mine.json.questionId, withdrawn: true });
        expect(attention.pending().map((p) => p.id)).toEqual([other.json.questionId]);
        expect(items().map((i) => i.id)).toEqual([other.json.questionId]);
        // COUNTED: zero messages anywhere — not to the agent, not to the person.
        expect(mailCount()).toBe(0);
    });

    it('another agent’s cancel is refused and nothing changes; the same agent from another workspace too; the owner’s works (control)', async () => {
        const asked = await call({ terminalId: 't-atlas', questions: engine });
        const id = String(asked.json.questionId);

        const byKai = await call({ terminalId: 't-kai', action: 'cancel', questionId: id });
        expect(byKai.isError).toBe(true);
        expect(byKai.text).toContain(id);
        const fromFancy = await call({ terminalId: 't-atlas-fancy', action: 'cancel', questionId: id });
        expect(fromFancy.isError).toBe(true);
        expect(attention.pending().map((p) => p.id)).toEqual([id]);

        const byAtlas = await call({ terminalId: 't-atlas', action: 'cancel', questionId: id });
        expect(byAtlas.isError).toBe(false);
        expect(attention.pending()).toEqual([]);
    });

    it('without a questionId it is refused by name — never treated as an ask', async () => {
        const r = await call({ terminalId: 't-atlas', action: 'cancel' });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/questionId/);
        expect(attention.pending()).toEqual([]);
    });

    it('the question window showing it moves on to the next', async () => {
        const first = await call({ terminalId: 't-atlas', questions: engine });
        const second = await call({ terminalId: 't-kai', questions: where });
        const log: string[] = [];
        const ctl = new QuestionWindow({
            items,
            open: () => ({ show: (v: QuestionView) => log.push(`show ${v.item.id}`), close: () => log.push('close') }),
            answer: async () => {},
            dismiss: async () => {},
        });
        attention.onChange(() => ctl.changed());
        ctl.changed();
        expect(ctl.showing).toBe(first.json.questionId);

        await call({ terminalId: 't-atlas', action: 'cancel', questionId: String(first.json.questionId) });
        expect(ctl.showing).toBe(second.json.questionId);
        expect(log.at(-1)).toBe(`show ${String(second.json.questionId)}`);
    });
});

describe('update', () => {
    it('replaces the content and priority in place: same id, same askedAt, the same place in the queue, a new revision', async () => {
        const first = await call({ terminalId: 't-atlas', questions: engine });
        const second = await call({ terminalId: 't-kai', questions: where });
        const before = attention.pending().find((p) => p.id === first.json.questionId)!;
        expect(deckBand(items()).map((i) => i.id)).toEqual([first.json.questionId, second.json.questionId]);

        const replacement = [{ header: 'Engine v2', question: 'Postgres **17** or 16?', options: [{ label: '17' }, { label: '16' }] }];
        const r = await call({ terminalId: 't-atlas', action: 'update', questionId: String(first.json.questionId), questions: replacement });
        expect(r.isError).toBe(false);
        expect(r.json).toMatchObject({ ok: true, questionId: first.json.questionId, revision: 1 });

        const after = attention.pending().find((p) => p.id === first.json.questionId)!;
        expect(after.questions).toEqual(replacement);
        expect(after.askedAt).toBe(before.askedAt);
        expect(after.revision).toBe(1);
        const item = items().find((i) => i.id === first.json.questionId)!;
        expect(item.title).toBe('Engine v2');
        expect(item.revision).toBe(1);
        // Still first: an update keeps its place; it does not jump to the back.
        expect(deckBand(items()).map((i) => i.id)).toEqual([first.json.questionId, second.json.questionId]);
        expect(attention.pending()).toHaveLength(2);
        expect(mailCount()).toBe(0);
    });

    it('the window showing it re-shows the NEW content, still the same question, and its form is keyed anew', async () => {
        const first = await call({ terminalId: 't-atlas', questions: engine });
        await call({ terminalId: 't-kai', questions: where });
        const shown: QuestionView[] = [];
        const ctl = new QuestionWindow({
            items,
            open: () => ({ show: (v: QuestionView) => shown.push(v), close: () => {} }),
            answer: async () => {},
            dismiss: async () => {},
        });
        attention.onChange(() => ctl.changed());
        ctl.changed();
        await call({ terminalId: 't-atlas', action: 'update', questionId: String(first.json.questionId), questions: [{ ...engine[0]!, question: 'Which engine, now that prod is on 17?' }] });
        const last = shown.at(-1)!;
        expect(last.item.id).toBe(first.json.questionId);
        expect(last.item.answer.kind === 'form' ? last.item.answer.questions?.[0]?.question : null).toBe('Which engine, now that prod is on 17?');
        // The form's key is `${id}:${revision}` (QuestionApp, Deck): a new revision is a new form — the old draft is dropped.
        expect(last.item.revision).toBe(1);
        expect(shown[0]!.item.revision).toBeUndefined();
    });

    it('another agent’s update is refused, as is a malformed one; nothing changes; the owner’s works (control)', async () => {
        const asked = await call({ terminalId: 't-atlas', questions: engine });
        const id = String(asked.json.questionId);
        const byKai = await call({ terminalId: 't-kai', action: 'update', questionId: id, questions: where });
        expect(byKai.isError).toBe(true);
        const malformed = await call({ terminalId: 't-atlas', action: 'update', questionId: id, questions: [] });
        expect(malformed.isError).toBe(true);
        expect(attention.pending()[0]!.questions).toEqual(engine);
        expect(attention.pending()[0]!.revision).toBeUndefined();

        const byAtlas = await call({ terminalId: 't-atlas', action: 'update', questionId: id, questions: where });
        expect(byAtlas.isError).toBe(false);
        expect(attention.pending()[0]!.questions).toEqual(where);
    });
});

describe('what agents are told', () => {
    it('an ask with no action is still an ask — the existing call is unchanged', async () => {
        const r = await call({ terminalId: 't-atlas', questions: engine });
        expect(r.isError).toBe(false);
        expect(String(r.json.questionId)).toMatch(/^q_/);
    });

    it('the tool says to keep the questionId and how to update and cancel; the schema no longer REQUIRES questions', () => {
        const def = tools.find((t) => t.definition.name === 'ForceTheQuestion')!.definition;
        expect(def.description).toMatch(/questionId — KEEP IT/);
        expect(def.description).toMatch(/"update"/);
        expect(def.description).toMatch(/"cancel"/);
        const schema = def.inputSchema as { required?: string[]; properties: Record<string, { enum?: string[] }> };
        expect(schema.properties.action?.enum).toEqual(['ask', 'update', 'cancel']);
        expect(schema.required ?? []).not.toContain('questions');
    });

    it('the genie-attention skill tells agents to keep the questionId and how to update or cancel', () => {
        const body = GENIE_SKILLS.find((s) => s.name === 'genie-attention')!.body;
        expect(body).toMatch(/Keep the questionId/);
        expect(body).toContain('action: "update"');
        expect(body).toContain('action: "cancel"');
    });
});
