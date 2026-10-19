import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';

/**
 * THE FORCETHEQUESTION WINDOW HAS ITS OWN QUEUE (the owner, 2026-10-15): "the question went to the deck and now I think I
 * understand why some go there. The FTQ window should have its own queue so I can answer any and all questions of all
 * agents just like genie 1 had. It seems I only get the ftq window if I have that agent active in my screen that sends
 * it. That is NOT proper ux for FTQ. FTQ does not care what screen or app I have open. If DnD is not turned on then FTQ
 * always opens for every agent. (be mindful of ui updates, no data should be lost in the forms a user is filling out if
 * another agent sends an ftq request while they are filling it out."
 *
 * The cause on origin/main: the window's view was ONE question and a count (`{ item, waiting }`), and the question on
 * screen is never swapped (core/question-queue.ts `nextQuestion` keeps `current`). So while one agent's question was up —
 * typically the agent the person was working with — a second agent's question had a toast, a row in the Deck, and in
 * the window only "1 more after this": nothing to read and nothing to answer until the first was answered or put off
 * with Later, which parks it. Do Not Disturb was not consulted at all. These tests import only modules that exist on
 * origin/main, so each is red there by its ASSERTION, not by a missing import.
 *
 * Names: agents kai and wren; workspaces in RFC 2606 `.example`.
 */
const q = (id: string, at: number, agentName: string, workspaceName: string, header = 'Pick'): DeckItem => ({
    id, source: 'agent-question', agentId: `agent_${agentName}`, agentName, workspaceId: `ws_${workspaceName}`, workspaceName, title: header, blocking: true, priority: 'normal', at,
    answer: { kind: 'form', fields: 1, questions: [{ header, question: `Which ${header.toLowerCase()}?`, options: [{ label: 'A' }, { label: 'B' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem);

// kai is the agent the person has on screen; wren works in another workspace, not on screen.
const kaiAsks = q('q_kai', 1_000, 'kai', 'shop.example', 'Engine');
const wrenAsks = q('q_wren', 2_000, 'wren', 'docs.example', 'Branch');

type Drafted = { drafts?: Record<string, { selections: readonly (readonly string[])[]; notes: readonly string[] }> };
type Queued = { queue?: readonly DeckItem[] };

function harness(initial: DeckItem[], dnd = false) {
    let items = initial;
    let dndOn = dnd;
    const log: string[] = [];
    const views: QuestionView[] = [];
    const answered: string[] = [];
    const sent: { selections: string[][]; notes: string[] }[] = [];
    const ctl = new QuestionWindow({
        items: () => items,
        open: () => {
            log.push('open');
            return { show: (v: QuestionView) => { views.push(v); log.push(`show ${v.item.id}`); }, close: () => log.push('close') };
        },
        answer: async (item, selections, notes) => { answered.push(item.id); sent.push({ selections, notes }); items = items.filter((i) => i.id !== item.id); },
        dismiss: async (item) => { items = items.filter((i) => i.id !== item.id); },
        dnd: () => dndOn,
    } as ConstructorParameters<typeof QuestionWindow>[0]);
    return {
        ctl, log, views, answered, sent,
        items: () => items,
        set: (next: DeckItem[]) => { items = next; ctl.changed(); },
        setDnd: (on: boolean) => { dndOn = on; },
        opens: () => log.filter((l) => l === 'open').length,
        last: () => views.at(-1)!,
    };
}

const render = (view: QuestionView) =>
    renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} now={10_000} />);
const queueEntries = (html: string) => [...html.matchAll(/data-question-queue-item="([^"]+)"/g)].map((m) => m[1]);
// `draft` exists only with the fix: called through an optional member so origin/main is red by assertion, not a TypeError.
const draftOn = (ctl: QuestionWindow, id: string, d: { selections: string[][]; notes: string[] }) =>
    (ctl as unknown as { draft?: (id: string, d: unknown) => void }).draft?.(id, d);

describe('a question from an agent that is NOT on screen reaches the window', () => {
    it('kai’s question is up; wren (not on screen) asks — wren’s question is IN the window, readable and pickable (counted)', () => {
        const h = harness([kaiAsks]);
        h.ctl.changed();
        h.set([kaiAsks, wrenAsks]);
        // The view carries the window's queue — both agents, oldest first.
        expect((h.last() as Queued).queue?.map((i) => i.id)).toEqual(['q_kai', 'q_wren']);
        // What the person sees: TWO entries, wren's among them, with its agent and workspace.
        const html = render(h.last());
        expect(queueEntries(html)).toEqual(['q_kai', 'q_wren']);
        expect(html).toMatch(/data-question-queue-item="q_wren"[^]*?wren[^]*?docs\.example/);
        // Still ONE window, and kai's question is still the one being answered — nothing swapped under the person.
        expect(h.opens()).toBe(1);
        expect(h.ctl.showing).toBe('q_kai');
    });

    it('control: nothing on screen at all — wren asks and the window opens for it (whatever screen or app is in front)', () => {
        const h = harness([]);
        h.ctl.changed();
        h.set([wrenAsks]);
        expect(h.log).toEqual(['open', 'show q_wren']);
    });

    it('control: Do Not Disturb ON — no window; the question is in Pending Questions (the Deck’s items) all the same', () => {
        const h = harness([], true);
        h.ctl.changed();
        h.set([wrenAsks]);
        expect(h.opens()).toBe(0);
        expect(h.ctl.showing).toBeNull();
        expect(h.items().map((i) => i.id)).toEqual(['q_wren']);
    });

    it('DND turned off again: the next NEW question opens the window, and the one asked during DND is listed with it (counted)', () => {
        const h = harness([], true);
        h.set([wrenAsks]);
        h.setDnd(false);
        // Turning DND off throws nothing at the person on its own...
        h.ctl.changed();
        expect(h.opens()).toBe(0);
        // ...the next question asked opens the window — on the NEW one — and the waiting one is in its queue.
        h.set([wrenAsks, q('q_kai2', 3_000, 'kai', 'shop.example', 'Deploy')]);
        expect(h.log).toEqual(['open', 'show q_kai2']);
        expect((h.last() as Queued).queue?.map((i) => i.id)).toEqual(['q_wren', 'q_kai2']);
    });
});

describe('two agents ask: ONE window with both in its queue', () => {
    it('kai then wren: one window opened, its queue holds 2, each answerable (counted)', () => {
        const h = harness([]);
        h.ctl.changed();
        h.set([kaiAsks]);
        h.set([kaiAsks, wrenAsks]);
        expect(h.opens()).toBe(1);
        expect((h.last() as Queued).queue).toHaveLength(2);
        expect(queueEntries(render(h.last()))).toHaveLength(2);
    });

    it('control: one agent, one question — no queue list is drawn (nothing to pick between)', () => {
        const h = harness([kaiAsks]);
        h.ctl.changed();
        expect(queueEntries(render(h.last()))).toHaveLength(0);
    });
});

describe('what the person is typing survives another agent asking', () => {
    const typed = { selections: [['B']], notes: ['use the staging one'] };

    it('a draft answer + note in kai’s question, then wren asks: kai’s draft is intact (exact) and the window shows both', () => {
        const h = harness([kaiAsks]);
        h.ctl.changed();
        draftOn(h.ctl, 'q_kai', typed);
        h.set([kaiAsks, wrenAsks]);
        const view = h.last();
        expect((view as Drafted).drafts?.['q_kai']).toEqual(typed);
        expect((view as Queued).queue?.map((i) => i.id)).toEqual(['q_kai', 'q_wren']);
        expect(h.ctl.showing).toBe('q_kai');
        // And on screen: the note's exact text, the picked option pressed, A not (Genie 1's toggle options, 2026-10-19).
        const html = render(view);
        expect(html).toContain('>use the staging one</textarea>');
        // Read each option TAG, then its attributes — never a pattern that assumes the renderer's attribute order.
        const options = html.match(/<button[^>]*data-question-option="[^"]*"[^>]*>/g) ?? [];
        const optionB = options.filter((tag) => tag.includes('data-question-option="B"'));
        expect(optionB).toHaveLength(1);
        expect(optionB[0]).toContain('aria-pressed="true"');
        // The same tag-wise read: an order-assuming pattern here could never fail, so the absence it claims would be empty.
        const optionA = options.filter((tag) => tag.includes('data-question-option="A"'));
        expect(optionA).toHaveLength(1);
        expect(optionA[0]).toContain('aria-pressed="false"');
    });

    it('answering wren’s question (picked from the queue) leaves kai’s draft intact and kai’s question on screen', async () => {
        const h = harness([kaiAsks, wrenAsks]);
        h.ctl.changed();
        draftOn(h.ctl, 'q_kai', typed);
        expect(await h.ctl.answer([['A']], ['ship it'], 'q_wren')).toEqual({ ok: true });
        // COUNTED: exactly one answer, wren's, with wren's selections and note.
        expect(h.answered).toEqual(['q_wren']);
        expect(h.sent).toEqual([{ selections: [['A']], notes: ['ship it'] }]);
        expect(h.ctl.showing).toBe('q_kai');
        expect((h.last() as Drafted).drafts?.['q_kai']).toEqual(typed);
        expect((h.last() as Queued).queue?.map((i) => i.id)).toEqual(['q_kai']);
    });

    it('control: answering kai’s own question drops kai’s draft — and only that one', async () => {
        const h = harness([kaiAsks, wrenAsks]);
        h.ctl.changed();
        draftOn(h.ctl, 'q_kai', typed);
        draftOn(h.ctl, 'q_wren', { selections: [[]], notes: ['later today'] });
        await h.ctl.answer([['B']], ['use the staging one'], 'q_kai');
        expect(h.answered).toEqual(['q_kai']);
        expect((h.last() as Drafted).drafts).toEqual({ q_wren: { selections: [[]], notes: ['later today'] } });
    });
});
