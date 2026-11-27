import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deckItemsFrom, questionStale, type AskerState } from '../src/core/deck-sources.js';
import type { DeckItem } from '../src/core/deck.js';
import type { PendingQuestion } from '../src/main/attention-store.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';
import { control } from './helpers/control-markup.js';

/**
 * AN OPEN FORCETHEQUESTION WINDOW CLOSED BY ITSELF (Tynn #1085; the owner, 2026-11-27: "I will have an FTQ window open and
 * then suddenly it closes. I see it as 'stale' in the dashboard.").
 *
 * Measured on the owner's data (read-only, ~/.genie/runtime): of 61 questions since 11-26, 7 went stale before they were
 * answered, every one by a restart of the asking agent's session — single restarts (exit and start in the same ms), a
 * restart of every agent at once, the boot that restored them, the beta.66.1 upgrade that stopped them. None was an agent
 * removed. A ForceTheQuestion never blocks: its answer is MAILED to the asker, so a session that ended, restarted, moved
 * account or came back after an upgrade still gets it. Only an agent gone from the roster no longer can.
 *
 * Red on origin/main: a session not running read `session-ended`, a run started after the ask read `earlier-run`, and the
 * window closed under the person the moment the question it showed went stale.
 */
const ASKED = Date.parse('2026-11-27T08:42:11.607Z');
const ONE = [{ header: 'Dev API', question: 'Which **API**?', options: [{ label: 'A' }, { label: 'B' }] }];
const pending = (id: string, agentId: string): PendingQuestion =>
    ({ id, key: id, agentId: agentId as never, agentName: agentId, workspaceId: 'ws_a', questions: ONE, priority: 'normal', askedAt: new Date(ASKED).toISOString() });
const roster = { moic: { name: 'moic', workspaceId: 'ws_a' } };
const deckFor = (session: AskerState | null, agents: Record<string, { name: string; workspaceId: string }> = roster) =>
    deckItemsFrom({ questions: [pending('q_1', 'moic')], userList: [], unreadDms: [], agents, asker: () => session })[0]!;

describe('a ForceTheQuestion stays live while its agent exists (#1085)', () => {
    const cases: ReadonlyArray<{ name: string; session: AskerState | null }> = [
        { name: 'its session ended (a turn over and the session stopped, or Stop)', session: { running: false, startedAt: ASKED - 60_000 } },
        { name: 'it has no session at all (Genie upgraded or quit; the agent not started again yet)', session: null },
        { name: 'its session restarted after the ask (the owner\'s moic: exit and run 35 at 08:43:12)', session: { running: true, startedAt: ASKED + 61_000 } },
        { name: 'it moved to another account (a new run after the ask)', session: { running: true, startedAt: ASKED + 5 * 60_000 } },
        { name: 'Genie booted and restored it (a run started an hour after the ask)', session: { running: true, startedAt: ASKED + 3_600_000 } },
    ];
    for (const c of cases) {
        it(`${c.name}: not stale`, () => {
            expect(deckFor(c.session).stale).toBeUndefined();
        });
    }

    it('its agent was REMOVED from the roster: stale, agent gone', () => {
        expect(deckFor({ running: true, startedAt: ASKED - 60_000 }, {}).stale).toBe('agent-gone');
        expect(deckFor(null, {}).stale).toBe('agent-gone');
    });

    it('control: a running session that started before the ask is live, as it always was', () => {
        expect(deckFor({ running: true, startedAt: ASKED - 60_000 }).stale).toBeUndefined();
    });

    it('control: liveness not heard yet judges nothing, not even an agent missing from the roster', () => {
        const item = deckItemsFrom({ questions: [pending('q_1', 'ghost')], userList: [], unreadDms: [], agents: {}, asker: () => undefined })[0]!;
        expect(item.stale).toBeUndefined();
    });

    it('questionStale judges only the roster', () => {
        expect(questionStale(true)).toBeNull();
        expect(questionStale(false)).toBe('agent-gone');
    });
});

const q = (id: string, at: number, over: Partial<DeckItem> = {}): DeckItem => ({
    id, source: 'agent-question', agentId: `agent_${id}`, agentName: 'moic', workspaceId: 'ws_a', workspaceName: 'Moic', title: 'Dev API', blocking: true, priority: 'normal', at,
    answer: { kind: 'form', fields: 1, questions: ONE },
    forwardedFrom: null,
    ...over,
} as unknown as DeckItem);

function harness(initial: DeckItem[]) {
    let items = initial;
    const log: string[] = [];
    const views: QuestionView[] = [];
    const answered: string[] = [];
    let closedCb: (() => void) | null = null;
    const ctl = new QuestionWindow({
        items: () => items,
        open: (onClosed) => {
            log.push('open'); closedCb = onClosed;
            return { show: (v) => { views.push(v); log.push(`show ${v.item.id}${v.item.stale ? ` stale=${v.item.stale}` : ''}`); }, close: () => { log.push('close'); closedCb?.(); } };
        },
        answer: async (item) => { answered.push(item.id); items = items.filter((i) => i.id !== item.id); },
        dismiss: async (item) => { items = items.filter((i) => i.id !== item.id); },
    });
    return { ctl, log, views, answered, set: (next: DeckItem[]) => { items = next; ctl.changed(); } };
}

describe('an open question window never closes under the person (#1085)', () => {
    it('the question on screen goes stale (its agent removed): the window stays on it, marked, and it can still be answered', async () => {
        const h = harness([q('q_1', 10)]);
        h.ctl.changed();
        expect(h.log).toEqual(['open', 'show q_1']);
        h.set([q('q_1', 10, { stale: 'agent-gone' })]);
        // Not closed: the same question, now carrying why its agent no longer waits.
        expect(h.log).toEqual(['open', 'show q_1', 'show q_1 stale=agent-gone']);
        expect(h.ctl.showing).toBe('q_1');
        expect(h.views.at(-1)!.queue.map((i) => i.id)).toEqual(['q_1']);
        // Answer anyway: it is sent, and with nothing left the window closes.
        expect(await h.ctl.answer([['A']], [''])).toEqual({ ok: true });
        expect(h.answered).toEqual(['q_1']);
        expect(h.log.at(-1)).toBe('close');
    });

    it('a stale question it holds stays while a live one arrives; the person moves on to the live one and the stale one is let go', () => {
        const h = harness([q('q_1', 10)]);
        h.ctl.changed();
        h.set([q('q_1', 10, { stale: 'agent-gone' }), q('q_2', 20)]);
        expect(h.ctl.showing).toBe('q_1');
        expect(h.views.at(-1)!.queue.map((i) => i.id)).toEqual(['q_1', 'q_2']);
        h.ctl.select('q_2');
        expect(h.ctl.showing).toBe('q_2');
        expect(h.views.at(-1)!.queue.map((i) => i.id)).toEqual(['q_2']);
    });

    it('control: a question its agent WITHDREW (cancelled) leaves the window, which closes with none left', () => {
        const h = harness([q('q_1', 10)]);
        h.ctl.changed();
        h.set([]);
        expect(h.log).toEqual(['open', 'show q_1', 'close']);
    });

    it('control: a stale question that was not on screen never opens the window', () => {
        const h = harness([q('q_1', 10, { stale: 'agent-gone' })]);
        h.ctl.changed();
        expect(h.log).toEqual([]);
    });
});

describe('the window says a held stale question, and offers Answer anyway (#1085)', () => {
    const view = (item: DeckItem): QuestionView => ({ item, waiting: 0, queue: [item], parked: [], drafts: {} });
    const render = (item: DeckItem) => renderToStaticMarkup(<QuestionApp view={view(item)} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} />);

    it('stale: a notice that its agent is gone, and the answer button reads Answer anyway', () => {
        const html = render(q('q_1', 10, { stale: 'agent-gone' }));
        expect(html).toContain('data-question-stale="agent-gone"');
        expect(html).toMatch(/moic is no longer in this workspace/);
        expect(control(html, 'data-action="deck-submit"')).toMatchObject({ tag: 'button', text: 'Answer anyway' });
    });

    it('control: live — no notice, and the button reads Answer', () => {
        const html = render(q('q_1', 10));
        expect(html).not.toContain('data-question-stale');
        expect(control(html, 'data-action="deck-submit"')).toMatchObject({ tag: 'button', text: 'Answer' });
        expect(html).not.toMatch(/Answer anyway/);
    });
});
