import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Question } from '../src/core/attention.js';
import { mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { needsYouCount } from '../src/core/deck.js';
import { HUMAN } from '../src/core/inbox.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import { QuestionWindow } from '../src/main/question-window.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * NOTES ON ANY AND ALL QUESTIONS, AND STALE ONES PUT ASIDE (the owner, 2026-10-15: "AND I NEED THE ABILITY TO ADD NOTES TO
 * ANY AND ALL QUESTIONS"; old items: "Keep, but mark stale"). Every question has a note per question in the Deck and in
 * the question window; the note reaches the agent's MAIL with the answer and with a dismissal. "Dismiss all stale" puts
 * aside exactly the stale questions the person saw — never a live one, never one they did not see.
 *
 * Exact mail text is asserted: the agent reads it, so the words are the contract.
 */
const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const STATE = { toolStatuses: null, knowledgeQuery: '' };
const q = (header: string): Question[] => [{ header, question: `About ${header}?`, options: [{ label: 'a' }, { label: 'b' }] }];

let dir: string;
let services: ComposedServices;
let roster: AgentRecord[];
let sessions: Record<string, { running: boolean; startedAt: number | null }>;
/** main.ts's "liveness known": false until the roster and the session host have reported once. */
let livenessKnown: boolean;
const enlist = (name: string): string => {
    const id = mintAgentId();
    roster.push({ id, workspaceId: 'ws_shop', provider: 'claude', name, instructions: null, threadId: null, createdAt: '2026-10-15T00:00:00.000Z', lastUsedAt: null } as never);
    return id;
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-deck-notes-'));
    roster = [];
    sessions = {};
    livenessKnown = true;
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
        roster: () => roster,
        askerLive: (id) => (livenessKnown ? sessions[id] ?? null : undefined),
    });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('a note reaches the agent', () => {
    it('answered in the Deck: each question’s note is in the mail under its answer (exact text)', async () => {
        const agent = enlist('kai');
        sessions[agent] = { running: true, startedAt: 0 };
        const asked = await services.attention.ask({ agentId: agent as never, agentName: 'kai', workspaceId: 'ws_shop', questions: q('Engine') }, { userActive: true });
        const item = services.deckItems().find((i) => i.id === asked.questionId)!;
        await handleFeatureAction(services, { kind: 'deck.answerForm', item, selections: [['a']], notes: ['sqlite for tests only'], note: '' }, STATE);
        const mail = services.inbox.unread(agent as never);
        expect(mail).toHaveLength(1);
        expect(mail[0]!.from).toBe(HUMAN);
        expect(mail[0]!.text).toBe(`Answer to your question ${asked.questionId}:\n- **Engine** — About Engine?\n  → a\n  Note: sqlite for tests only`);
    });

    it('dismissed in the Deck: the note goes WITH the dismissal, under its question’s header (exact text)', async () => {
        const agent = enlist('kai');
        const asked = await services.attention.ask({ agentId: agent as never, agentName: 'kai', workspaceId: 'ws_shop', questions: q('Engine') }, { userActive: true });
        const item = services.deckItems().find((i) => i.id === asked.questionId)!;
        await handleFeatureAction(services, { kind: 'deck.dismiss', item, notes: ['not now — ship first'] }, STATE);
        const mail = services.inbox.unread(agent as never);
        expect(mail).toHaveLength(1);
        expect(mail[0]!.text).toBe(
            `Engine: dismissed by the person, without an answer.\n(Your question ${asked.questionId}. Nothing was chosen; decide without it, or ask again if it still matters.)\nNote on Engine: not now — ship first`,
        );
    });

    it('several questions: only the noted one is said; control: a blank note says nothing, and no notes is the plain dismissal', async () => {
        const agent = enlist('kai');
        const two = await services.attention.ask({ agentId: agent as never, agentName: 'kai', workspaceId: 'ws_shop', questions: [...q('Engine'), ...q('Where')] }, { userActive: true });
        await handleFeatureAction(services, { kind: 'deck.dismiss', item: services.deckItems().find((i) => i.id === two.questionId)!, notes: ['   ', 'ask again Monday'] }, STATE);
        const plain = await services.attention.ask({ agentId: agent as never, agentName: 'kai', workspaceId: 'ws_shop', questions: q('Cache') }, { userActive: true });
        await handleFeatureAction(services, { kind: 'deck.dismiss', item: services.deckItems().find((i) => i.id === plain.questionId)! }, STATE);
        const [first, second] = services.inbox.unread(agent as never);
        expect(first!.text.split('\n').filter((l) => l.startsWith('Note on '))).toEqual(['Note on Where: ask again Monday']);
        expect(second!.text).toBe(`Cache: dismissed by the person, without an answer.\n(Your question ${plain.questionId}. Nothing was chosen; decide without it, or ask again if it still matters.)`);
    });

    it('dismissed in the question window: the form’s notes travel through the window to the same mail (exact text)', async () => {
        const agent = enlist('kai');
        // The window shows only LIVE questions (core/question-queue.ts): the asking agent has a running session that started
        // before it asked. Without one its question is stale ("session ended") and stays in the Deck, never in the window.
        sessions[agent] = { running: true, startedAt: 0 };
        const asked = await services.attention.ask({ agentId: agent as never, agentName: 'kai', workspaceId: 'ws_shop', questions: q('Engine') }, { userActive: true });
        const shown: string[] = [];
        const ctl = new QuestionWindow({
            items: () => services.deckItems(),
            open: () => ({ show: (v) => { shown.push(v.item.id); }, close: () => {} }),
            answer: async () => { throw new Error('not in this test'); },
            // main.ts's wiring: the same feature action as the Deck's, with the notes.
            dismiss: async (item, notes) => { await handleFeatureAction(services, { kind: 'deck.dismiss', item, notes }, STATE); },
        });
        ctl.changed();
        // Positive control: the window IS showing this question before it is dismissed from it.
        expect(shown).toEqual([asked.questionId]);
        expect(ctl.showing).toBe(asked.questionId);
        expect(await ctl.dismiss(['use the queue instead'])).toEqual({ ok: true });
        expect(services.inbox.unread(agent as never).map((m) => m.text)).toEqual([
            `Engine: dismissed by the person, without an answer.\n(Your question ${asked.questionId}. Nothing was chosen; decide without it, or ask again if it still matters.)\nNote on Engine: use the queue instead`,
        ]);
    });
});

describe('stale questions on the composed Deck, and "Dismiss all stale"', () => {
    it('marks each by why; dismisses exactly the stale ones the person saw — a live one sent with them stays, and so does a stale one they did not see', async () => {
        const kai = enlist('kai');
        const wren = enlist('wren');
        const ivy = enlist('ivy');
        const ghost = mintAgentId();
        sessions[kai] = { running: true, startedAt: 0 };
        sessions[wren] = { running: false, startedAt: 0 };
        // ivy's session started after it asked: an earlier run asked.
        sessions[ivy] = { running: true, startedAt: Date.now() + 3_600_000 };
        const ask = (agentId: string, name: string, header: string) => services.attention.ask({ agentId: agentId as never, agentName: name, workspaceId: 'ws_shop', questions: q(header) }, { userActive: true });
        const live = await ask(kai, 'kai', 'Live');
        const ended = await ask(wren, 'wren', 'Ended');
        const earlier = await ask(ivy, 'ivy', 'Earlier');
        const gone = await ask(ghost, 'ghost', 'Gone');

        const stale = Object.fromEntries(services.deckItems().filter((i) => i.source === 'agent-question').map((i) => [i.id, i.stale ?? 'live']));
        expect(stale).toEqual({ [live.questionId]: 'live', [ended.questionId]: 'session-ended', [earlier.questionId]: 'earlier-run', [gone.questionId]: 'agent-gone' });

        // The person saw `ended` and `gone` marked stale (ivy's arrived after); a LIVE id rides along (a race, or a bad caller).
        await handleFeatureAction(services, { kind: 'deck.dismissStale', ids: [ended.questionId, gone.questionId, live.questionId] }, STATE);

        // COUNTED: two left; the live one and the stale one not seen stay.
        expect(services.attention.pending().map((p) => p.id).sort()).toEqual([live.questionId, earlier.questionId].sort());
        expect(services.inbox.unread(wren as never)).toHaveLength(1);
        expect(services.inbox.unread(ghost as never)).toHaveLength(1);
        // Controls: the live agent and the unseen stale one heard nothing.
        expect(services.inbox.unread(kai as never)).toHaveLength(0);
        expect(services.inbox.unread(ivy as never)).toHaveLength(0);
    });
});

describe('liveness not known yet', () => {
    it('before the roster and sessions have reported once, no question is stale — the gone agent’s included — and the rail counts them; control: once known, it is', async () => {
        livenessKnown = false;
        const kai = enlist('kai');
        const ghost = mintAgentId();
        await services.attention.ask({ agentId: kai as never, agentName: 'kai', workspaceId: 'ws_shop', questions: q('Live') }, { userActive: true });
        const gone = await services.attention.ask({ agentId: ghost, agentName: 'ghost', workspaceId: 'ws_shop', questions: q('Gone') }, { userActive: true });
        const before = services.deckItems().filter((i) => i.source === 'agent-question');
        expect(before).toHaveLength(2);
        expect(before.filter((i) => i.stale !== undefined)).toHaveLength(0);
        expect(needsYouCount(services.deckItems())).toBe(2);
        // "Dismiss all stale" sent now (a stale screen from before) removes nothing: unknown is not stale.
        await handleFeatureAction(services, { kind: 'deck.dismissStale', ids: [gone.questionId] }, STATE);
        expect(services.attention.pending()).toHaveLength(2);

        livenessKnown = true;
        sessions[kai] = { running: true, startedAt: 0 };
        expect(services.deckItems().find((i) => i.id === gone.questionId)!.stale).toBe('agent-gone');
        expect(needsYouCount(services.deckItems())).toBe(1);
    });
});

describe('main wires it', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the Deck judges staleness by the session host AND the Take Over host (a terminal agent is not "gone")', () => {
        expect(main.match(/askerLive:\s*\(id\)\s*=>/g) ?? []).toHaveLength(1);
        const body = main.slice(main.indexOf('askerLive:'), main.indexOf('askerLive:') + 900);
        expect(body).toMatch(/host\?\.probe\(id as AgentId\)/);
        expect(body).toMatch(/takeOvers\?\.probe\(id as AgentId\)/);
        // Unknown until the first roster load: undefined, judged as nothing.
        expect(body).toMatch(/if \(!askerLivenessKnown\) return undefined;/);
        expect(main.match(/askerLivenessKnown = host !== null;/g) ?? []).toHaveLength(1);
        expect(main.indexOf('askerLivenessKnown = host !== null;')).toBeGreaterThan(main.indexOf('await registry.load('));
    });
    it('the question window’s Dismiss sends the notes on to deck.dismiss', () => {
        expect(main.match(/dismiss:\s*async\s*\(item,\s*notes\)\s*=>\s*\{\s*await handleFeatureAction\(composed,\s*\{\s*kind:\s*'deck\.dismiss',\s*item,\s*notes\s*\}/g) ?? []).toHaveLength(1);
    });
});
