import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';

/**
 * THE FORCETHEQUESTION WINDOW (the owner, 2026-10-14: "the FTQ window is a window that opens on top of all other windows
 * to ForceTheQuestion. It is not some tucked away ux, that is PendingQuestions (fed by the same workflow and in sync)").
 * Five questions sat unseen. Genie 1's rules: one shared window, the oldest question first, never swapped under the
 * person answering, the next after an answer, closed when none are left; Later and closing PARK the question (it stays
 * in Pending Questions); a question answered in Pending Questions leaves the window too.
 */
const q = (id: string, at: number, agentName = 'kai'): DeckItem => ({
    id, source: 'agent-question', agentId: `agent_${id}`, agentName, workspaceId: 'tynn', title: 'Which?', blocking: false, priority: 'normal', at,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Pick', question: 'Which **one**?', options: [{ label: 'A', description: 'the first' }, { label: 'B' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem);

function harness(initial: DeckItem[]) {
    let items = initial;
    const log: string[] = [];
    let closedCb: (() => void) | null = null;
    let open = false;
    const answered: string[] = [];
    let refuse: string | null = null;
    const ctl = new QuestionWindow({
        items: () => items,
        open: (onClosed) => {
            log.push('open'); open = true; closedCb = onClosed;
            return {
                show: (v: QuestionView) => log.push(`show ${v.item.id} +${v.waiting}`),
                close: () => { log.push('close'); open = false; closedCb?.(); },
            };
        },
        answer: async (item) => {
            if (refuse) throw new Error(refuse);
            answered.push(item.id);
            items = items.filter((i) => i.id !== item.id);
        },
    });
    return {
        ctl, log, answered,
        set: (next: DeckItem[]) => { items = next; ctl.changed(); },
        personCloses: () => { open = false; closedCb?.(); },
        isOpen: () => open,
        refuseWith: (r: string | null) => { refuse = r; },
    };
}

describe('the ForceTheQuestion window', () => {
    it('a question asked opens it; the OLDEST is shown first, with how many wait behind', () => {
        const h = harness([q('b', 20), q('a', 10)]);
        h.ctl.changed();
        expect(h.log).toEqual(['open', 'show a +1']);
    });

    it('an older question arriving never swaps the one on screen', () => {
        const h = harness([q('b', 20)]);
        h.ctl.changed();
        h.set([q('b', 20), q('a', 10)]);
        expect(h.log.at(-1)).toBe('show b +1');
    });

    it('answering sends it, shows the next, and closes when none are left', async () => {
        const h = harness([q('a', 10), q('b', 20)]);
        h.ctl.changed();
        expect(await h.ctl.answer([['A']], '')).toEqual({ ok: true });
        expect(h.answered).toEqual(['a']);
        expect(h.log.at(-1)).toBe('show b +0');
        await h.ctl.answer([['B']], 'note');
        // COUNTED: one open, one close.
        expect(h.log.filter((l) => l === 'open')).toHaveLength(1);
        expect(h.log.at(-1)).toBe('close');
        expect(h.isOpen()).toBe(false);
    });

    it('Later parks it (it stays pending) and shows the next; it is not shown again this session', () => {
        const h = harness([q('a', 10), q('b', 20)]);
        h.ctl.changed();
        h.ctl.later();
        expect(h.log.at(-1)).toBe('show b +0');
        h.ctl.later();
        expect(h.log.at(-1)).toBe('close');
        h.ctl.changed();
        expect(h.log.filter((l) => l === 'open')).toHaveLength(1);
    });

    it('answered in Pending Questions: the window moves on with it — one workflow', () => {
        const h = harness([q('a', 10), q('b', 20)]);
        h.ctl.changed();
        h.set([q('b', 20)]);
        expect(h.log.at(-1)).toBe('show b +0');
        h.set([]);
        expect(h.log.at(-1)).toBe('close');
    });

    it('the person closing it parks what was there; a NEW question opens it again', () => {
        const h = harness([q('a', 10)]);
        h.ctl.changed();
        h.personCloses();
        h.ctl.changed();
        expect(h.log.filter((l) => l === 'open')).toHaveLength(1);
        h.set([q('a', 10), q('c', 30)]);
        expect(h.log.slice(-2)).toEqual(['open', 'show c +0']);
    });

    it('a refused answer comes back with the reason and the question stays on screen', async () => {
        const h = harness([q('a', 10)]);
        h.ctl.changed();
        h.refuseWith('answer every question');
        expect(await h.ctl.answer([[]], '')).toEqual({ ok: false, reason: 'answer every question' });
        expect(h.ctl.showing).toBe('a');
    });
});

describe('what the window shows', () => {
    const view = { item: q('a', 10, 'kai'), waiting: 2 };
    const html = renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} />);
    it('who asks, from where, how many more; the question as Markdown; each option with its description; Answer and Later', () => {
        expect(html).toContain('kai asks you');
        expect(html).toContain('data-question-workspace="tynn"');
        expect(html).toContain('data-question-waiting="2"');
        expect(html).toMatch(/<strong>one<\/strong>/);
        expect(html).toContain('the first');
        expect(html).toMatch(/data-action="deck-submit"[^>]*>Answer</);
        expect(html).toMatch(/data-action="question-cancel"[^>]*>Later</);
    });
    it('a refusal is said in the window', () => {
        const refused = renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal="answer every question" onAnswer={() => {}} onLater={() => {}} />);
        expect(refused).toContain('answer every question');
    });
});

