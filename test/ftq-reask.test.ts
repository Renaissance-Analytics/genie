import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Question } from '../src/core/attention.js';
import type { DeckItem } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { mintAgentId } from '../src/core/identity.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';

/**
 * AN AGENT ASKING AGAIN IS AN ASK. A repeat of a pending question is rejoined to it (same id — attention-store.ts), and
 * on origin/main the rejoin wrote nothing and announced nothing: a question the person had put off with Later (or by
 * closing the window) never came back to the window, however many times its agent asked — it was only in the Deck.
 * Now the rejoin is recorded (`asks`, `reaskedAt`) and announced, the window lifts the park and opens on it (unless Do
 * Not Disturb is on), and the draft the person had started is still in it. Its liveness is judged from the latest ask.
 *
 * Real store, real Deck items, the window's controller — the path a re-ask takes. Agent kai; workspace shop.example.
 */
const questions: Question[] = [{ header: 'Engine', question: 'Which engine?', options: [{ label: 'A' }, { label: 'B' }] }];
const typed = { selections: [['B']], notes: ['use the staging one'] };
// `draft` exists only with the queue fix: called through an optional member so a missing method is not the red.
const draftOn = (ctl: QuestionWindow, id: string, d: unknown) => (ctl as unknown as { draft?: (id: string, d: unknown) => void }).draft?.(id, d);

describe('a re-ask brings a put-off question back to the window', () => {
    let dir: string;
    let store: AttentionStore;
    let clock: number;
    const now = () => new Date(clock).toISOString();
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-reask-'));
        clock = Date.parse('2026-10-15T09:00:00.000Z');
        const inbox = await InboxStore.open(dir, now);
        store = await AttentionStore.open(dir, inbox, now);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    function wire(dnd: { on: boolean }) {
        const log: string[] = [];
        const views: QuestionView[] = [];
        let changes = 0;
        const items = (): DeckItem[] => deckItemsFrom({ questions: store.pending(), userList: [], unreadDms: [], finished: [], agents: {}, workspaceNames: {} });
        const ctl = new QuestionWindow({
            items,
            open: () => { log.push('open'); return { show: (v: QuestionView) => { views.push(v); log.push(`show ${v.item.id}`); }, close: () => log.push('close') }; },
            answer: async () => {},
            dismiss: async () => {},
            dnd: () => dnd.on,
        } as ConstructorParameters<typeof QuestionWindow>[0]);
        store.onChange(() => { changes += 1; ctl.changed(); });
        return { ctl, log, views, changes: () => changes, opens: () => log.filter((l) => l === 'open').length };
    }

    it('put A off (Later); its agent asks A again: the window opens on A, its draft intact — counted', async () => {
        const w = wire({ on: false });
        const agent = mintAgentId();
        const first = await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true });
        expect(w.log).toEqual(['open', `show ${first.questionId}`]);
        draftOn(w.ctl, first.questionId, typed);
        w.ctl.later();
        expect(w.log.at(-1)).toBe('close');
        expect(w.ctl.showing).toBeNull();
        const changesBefore = w.changes();

        clock += 60_000;
        const again = await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true });

        // Still ONE question — the same id, rejoined — but the re-ask was announced: exactly one change.
        expect(again).toMatchObject({ questionId: first.questionId, rejoined: true });
        expect(store.pending()).toHaveLength(1);
        expect(w.changes() - changesBefore).toBe(1);
        // COUNTED: a second window, on A.
        expect(w.opens()).toBe(2);
        expect(w.ctl.showing).toBe(first.questionId);
        expect(w.log.at(-1)).toBe(`show ${first.questionId}`);
        // The draft the person started is still in it, exactly; and A is no longer marked as put off.
        const view = w.views.at(-1)! as QuestionView & { drafts?: Record<string, unknown>; parked?: readonly string[] };
        expect(view.drafts?.[first.questionId]).toEqual(typed);
        expect(view.parked).toEqual([]);
    });

    it('control: Do Not Disturb ON — the re-ask is recorded and announced, and opens NOTHING', async () => {
        const dnd = { on: false };
        const w = wire(dnd);
        const agent = mintAgentId();
        const first = await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true });
        w.ctl.later();
        dnd.on = true;
        clock += 60_000;
        await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true, dnd: { on: true, reply: 'Away.' } });
        expect(store.pending().map((p) => p.id)).toEqual([first.questionId]);
        expect(w.opens()).toBe(1);
        expect(w.ctl.showing).toBeNull();
    });

    it('control: a question never put off is not opened twice by a re-ask — the window already shows it (one window)', async () => {
        const w = wire({ on: false });
        const agent = mintAgentId();
        const first = await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true });
        clock += 60_000;
        await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true });
        expect(w.opens()).toBe(1);
        expect(w.ctl.showing).toBe(first.questionId);
    });
});

describe('a re-asked question is judged live from its LATEST ask', () => {
    it('first asked by an earlier run, asked again by the run now: live (and its age stays the first ask’s)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie2-reask-live-'));
        try {
            let clock = Date.parse('2026-10-15T09:00:00.000Z');
            const now = () => new Date(clock).toISOString();
            const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
            const agent = mintAgentId();
            await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true });
            const firstAt = clock;
            // The agent's session restarts at 09:05 and asks the same question at 09:06.
            const startedAt = Date.parse('2026-10-15T09:05:00.000Z');
            const judge = () => deckItemsFrom({ questions: store.pending(), userList: [], unreadDms: [], finished: [], agents: { [agent]: { name: 'kai', workspaceId: 'ws_shop' } }, asker: () => ({ running: true, startedAt }) })[0]!;
            // Control: before the re-ask it IS stale — asked by the earlier run.
            expect(judge().stale).toBe('earlier-run');
            clock = Date.parse('2026-10-15T09:06:00.000Z');
            await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'ws_shop', questions }, { userActive: true });
            expect(judge().stale).toBeUndefined();
            expect(judge().at).toBe(firstAt);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
