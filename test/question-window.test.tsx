import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deckSections, needsYouCount, type DeckItem } from '../src/core/deck.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';

/**
 * THE FORCETHEQUESTION WINDOW (the owner, 2026-10-14: "the FTQ window is a window that opens on top of all other windows
 * to ForceTheQuestion. It is not some tucked away ux, that is PendingQuestions (fed by the same workflow and in sync)").
 * Five questions sat unseen. Genie 1's rules: one shared window, the oldest question first, never swapped under the
 * person answering, the next after an answer, closed when none are left; Later and closing PARK the question (it stays
 * in Pending Questions); a question answered in Pending Questions leaves the window too.
 *
 * Closing parks ONLY the question that was shown (the owner, 2026-10-15: "I got a toast but no FTQ popup; I see the
 * question in the Deck" — closing had parked every question the window held, including ones queued behind it that the
 * person never saw). A question arriving while the window is closing still ends up shown.
 *
 * On beta.26 (the owner, 2026-10-14): "I click the answer button but nothing happens." The refusal was printed at the TOP
 * of a scrolled window while the person was looking at the button. Now it is said beside the button, and each question
 * carries its own note, which travels with the answer.
 */
const q = (id: string, at: number, agentName = 'kai'): DeckItem => ({
    id, source: 'agent-question', agentId: `agent_${id}`, agentName, workspaceId: 'ws_01HTYNN', workspaceName: 'Tynn.ai', title: 'Pick', blocking: false, priority: 'normal', at,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Pick', question: 'Which **one**?', options: [{ label: 'A', description: 'the first' }, { label: 'B' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem);

function harness(initial: DeckItem[]) {
    let items = initial;
    const log: string[] = [];
    let closedCb: (() => void) | null = null;
    let open = false;
    const answered: string[] = [];
    const dismissed: string[] = [];
    const sent: { selections: string[][]; notes: string[] }[] = [];
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
        answer: async (item, selections, notes) => {
            if (refuse) throw new Error(refuse);
            answered.push(item.id);
            sent.push({ selections, notes });
            items = items.filter((i) => i.id !== item.id);
        },
        dismiss: async (item) => {
            if (refuse) throw new Error(refuse);
            dismissed.push(item.id);
            items = items.filter((i) => i.id !== item.id);
        },
    });
    return {
        ctl, log, answered, dismissed, sent,
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
        expect(await h.ctl.answer([['A']], [''])).toEqual({ ok: true });
        expect(h.answered).toEqual(['a']);
        expect(h.log.at(-1)).toBe('show b +0');
        await h.ctl.answer([['B']], ['note']);
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

    it('closing with two queued behind parks ONLY the shown one: the window comes back at once for the next (counted)', () => {
        const h = harness([q('a', 10), q('b', 20), q('c', 30)]);
        h.ctl.changed();
        expect(h.log).toEqual(['open', 'show a +2']);
        h.personCloses();
        // COUNTED: a second window, showing b — with ONE waiting behind it (c): a is parked, b and c are not.
        expect(h.log).toEqual(['open', 'show a +2', 'open', 'show b +1']);
        expect(h.ctl.showing).toBe('b');
        // The park set is exactly {a}: Later on b shows c (never a again), Later on c closes, and nothing reopens.
        h.ctl.later();
        expect(h.log.at(-1)).toBe('show c +0');
        h.ctl.later();
        expect(h.log.at(-1)).toBe('close');
        h.ctl.changed();
        expect(h.log.filter((l) => l === 'open')).toHaveLength(2);
        expect(h.log.filter((l) => l.startsWith('show a '))).toHaveLength(1);
    });

    it('a refused answer comes back with the reason and the question stays on screen', async () => {
        const h = harness([q('a', 10)]);
        h.ctl.changed();
        h.refuseWith('Pick needs an option or a note');
        expect(await h.ctl.answer([[]], [''])).toEqual({ ok: false, reason: 'Pick needs an option or a note' });
        expect(h.ctl.showing).toBe('a');
    });

    it('each question’s note travels with the answer, in order, to the same action Pending Questions uses', async () => {
        const h = harness([q('a', 10)]);
        h.ctl.changed();
        expect(await h.ctl.answer([[]], ['neither — use C'])).toEqual({ ok: true });
        expect(h.sent).toEqual([{ selections: [[]], notes: ['neither — use C'] }]);
    });
});

describe('only LIVE questions take the window (stale ones stay in the Deck, marked)', () => {
    const stale = (id: string, at: number, reason: 'session-ended' | 'earlier-run'): DeckItem => ({ ...q(id, at), stale: reason });

    it('two stale and one live: the window opens on the LIVE one, with nothing waiting behind it; the Deck still holds all three', () => {
        // The stale ones are OLDER — on origin/main the oldest-first queue showed one of them.
        const items = [stale('old1', 10, 'earlier-run'), stale('old2', 20, 'session-ended'), q('live', 30)];
        const h = harness(items);
        h.ctl.changed();
        // COUNTED: one window, the live question, +0 (stale ones are not "waiting behind").
        expect(h.log).toEqual(['open', 'show live +0']);
        // The Deck counts them: one waiting on you, two stale — kept, in the workspace's section.
        expect(needsYouCount(items)).toBe(1);
        expect(deckSections(items).map((s) => [s.live, s.stale])).toEqual([[1, 2]]);
    });

    it('only stale questions: no window at all — they are in the Deck', () => {
        const h = harness([stale('old1', 10, 'earlier-run'), stale('old2', 20, 'session-ended')]);
        h.ctl.changed();
        expect(h.log).toEqual([]);
        expect(h.ctl.showing).toBeNull();
    });

    it('control: all live — the window shows the OLDEST, with the others counted behind it', () => {
        const h = harness([q('c', 30), q('a', 10), q('b', 20)]);
        h.ctl.changed();
        expect(h.log).toEqual(['open', 'show a +2']);
    });
});

describe('a question arriving while the window is closing', () => {
    /** Windows that close the way Electron's do: `close()` only ASKS; `closed` arrives later. */
    function slowWindows(initial: DeckItem[]) {
        let items = initial;
        const windows: { shown: string[]; closeAsked: boolean; closed: boolean; fireClosed: () => void }[] = [];
        const ctl = new QuestionWindow({
            items: () => items,
            open: (onClosed) => {
                const w = { shown: [] as string[], closeAsked: false, closed: false, fireClosed: () => { w.closed = true; onClosed(); } };
                windows.push(w);
                return { show: (v: QuestionView) => { w.shown.push(v.item.id); }, close: () => { w.closeAsked = true; } };
            },
            answer: async () => {},
            dismiss: async () => {},
        });
        return { ctl, windows, set: (next: DeckItem[]) => { items = next; ctl.changed(); } };
    }

    it('the late question is shown in a window that is not closing — and stays shown when the old one’s `closed` arrives', () => {
        const h = slowWindows([q('a', 10)]);
        h.ctl.changed();
        // a is answered elsewhere: the window is asked to close, and has not closed yet...
        h.set([]);
        expect(h.windows[0]!.closeAsked).toBe(true);
        // ...when b arrives.
        h.set([q('b', 20)]);
        h.windows[0]!.fireClosed();
        // COUNTED: two windows; b is in the second, which nobody asked to close; b is what is showing.
        expect(h.windows).toHaveLength(2);
        expect(h.windows[1]!.shown).toEqual(['b']);
        expect(h.windows[1]!.closeAsked).toBe(false);
        expect(h.windows[0]!.shown).toEqual(['a']);
        expect(h.ctl.showing).toBe('b');
    });

    it('control: the old window’s `closed` does not park the late question — the person never closed anything', () => {
        const h = slowWindows([q('a', 10)]);
        h.ctl.changed();
        h.set([]);
        h.set([q('b', 20)]);
        h.windows[0]!.fireClosed();
        // b still answerable in the window: a later change keeps it on screen, no third window.
        h.set([q('b', 20)]);
        expect(h.ctl.showing).toBe('b');
        expect(h.windows).toHaveLength(2);
    });
});

describe('Dismiss in the window', () => {
    it('dismisses the shown question through the same action as the Deck, ONCE, and shows the next; closes when none are left', async () => {
        const h = harness([q('a', 10), q('b', 20)]);
        h.ctl.changed();
        expect(await h.ctl.dismiss()).toEqual({ ok: true });
        // COUNTED: exactly one dismiss, of the question on screen; nothing answered.
        expect(h.dismissed).toEqual(['a']);
        expect(h.answered).toEqual([]);
        expect(h.log.at(-1)).toBe('show b +0');
        await h.ctl.dismiss();
        expect(h.log.at(-1)).toBe('close');
    });

    it('a refused dismiss comes back with the reason and the question stays on screen', async () => {
        const h = harness([q('a', 10)]);
        h.ctl.changed();
        h.refuseWith('no pending question a');
        expect(await h.ctl.dismiss()).toEqual({ ok: false, reason: 'no pending question a' });
        expect(h.ctl.showing).toBe('a');
    });
});

describe('what the window shows', () => {
    const view = { item: q('a', 10, 'kai'), waiting: 2 };
    const html = renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} />);
    it('who asks, from where (the workspace NAME, not its id), how many more; the question as Markdown; each option with its description; Answer, Later and Dismiss', () => {
        expect(html).toContain('kai asks you');
        expect(html).toMatch(/data-question-workspace="ws_01HTYNN"[^>]*>Tynn\.ai</);
        // The id is an attribute for tests, never text a person reads.
        expect(html).not.toContain('>ws_01HTYNN<');
        expect(html).toMatch(/data-action="question-dismiss"[^>]*>Dismiss</);
        expect(html).toContain('data-question-waiting="2"');
        expect(html).toMatch(/<strong>one<\/strong>/);
        expect(html).toContain('the first');
        expect(html).toMatch(/data-action="deck-submit"[^>]*>Answer</);
        expect(html).toMatch(/data-action="question-cancel"[^>]*>Later</);
    });
    it('a refusal is said BESIDE the Answer button (role="alert"), once — not at the top of the scrolled window', () => {
        const refused = renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal="Pick needs an option or a note" onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} />);
        // COUNTED: one saying of it, and it comes after the button the person pressed.
        expect(refused.split('Pick needs an option or a note').length - 1).toBe(1);
        expect(refused).toMatch(/data-action="deck-submit"[^]*role="alert"[^>]*>Pick needs an option or a note</);
        // Control: no refusal, no alert.
        expect(html).not.toContain('role="alert"');
    });
    it('the question has its own note, and Answer waits (disabled, with the count) until it has an option or a note', () => {
        expect((html.match(/<textarea[^>]*data-deck-note="a"/g) ?? []).length).toBe(1);
        expect(html).toMatch(/<button[^>]*data-action="deck-submit"[^>]*disabled=""/);
        expect(html).toContain('1 of 1 still needs an option or a note');
    });
});

