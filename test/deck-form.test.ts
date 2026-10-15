import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { resolveDeckForm, unansweredCount } from '../src/core/deck-resolve.js';

/**
 * A MULTI-PART QUESTION IS ANSWERED IN PLACE (§4.5): "A multi-part, multi-select or free-text question expands into a
 * full form in place." The board audit of 2026-10-12 found "Answer N questions" navigating to the agent's stream. Now
 * the Deck item carries the questions themselves, and `resolveDeckForm` turns the filled form into the one answer the
 * attention store takes — or a refusal that says what is missing.
 *
 * EVERY QUESTION HAS ITS OWN NOTE, AND A NOTE ALONE ANSWERS IT (the owner, 2026-10-14, on beta.26: "I should have a note
 * section for every question asked … Look at the old FTQ interface"). Genie 1's rule (genie renderer/lib/ask-state.ts
 * `isDraftReady`): a question is answered by at least one option OR a non-blank note. A single-select still takes at most
 * one label, every label is one of that question's options, and a question with neither is refused by name.
 */
const questions = [
    { header: 'Workers', question: 'How many workers?', options: [{ label: '4' }, { label: '8' }] },
    { header: 'Scope', question: 'Which suites?', options: [{ label: 'unit' }, { label: 'e2e' }, { label: 'smoke' }], multiSelect: true },
];
const input = {
    agents: { a1: { name: 'lark', workspaceId: 'moic' } },
    questions: [{ id: 'q_1', key: 'k1', agentId: 'a1', agentName: 'lark', workspaceId: 'moic', priority: 'normal' as const, askedAt: '2026-10-12T14:00:00Z', questions }],
    userList: [], unreadDms: [], finished: [],
};

describe('a form item carries its questions', () => {
    it('so the Deck can draw the form where the item is read', () => {
        const [item] = deckItemsFrom(input as never);
        expect(item!.answer.kind).toBe('form');
        expect(item!.answer.kind === 'form' ? item!.answer.fields : 0).toBe(2);
        expect(item!.answer.kind === 'form' ? (item!.answer.questions ?? []).map((q) => q.header) : []).toEqual(['Workers', 'Scope']);
    });
});

describe('unansweredCount — the one readiness rule the form and the resolver share', () => {
    it('COUNTS the questions with neither an option nor a non-blank note', () => {
        // Control: nothing filled in — all three need an answer.
        expect(unansweredCount(3, [[], [], []], ['', '', ''])).toBe(3);
        expect(unansweredCount(3, [['4'], [], []], ['', '', ''])).toBe(2);
        // A note alone answers its question; whitespace is no note.
        expect(unansweredCount(3, [['4'], [], []], ['', 'only if it is quick', '   '])).toBe(1);
        expect(unansweredCount(3, [['4'], [], ['x']], ['', 'only if it is quick', ''])).toBe(0);
        // Missing entries count as empty, never as answered.
        expect(unansweredCount(2, [], [])).toBe(2);
    });
});

describe('resolveDeckForm', () => {
    const item: DeckItem = { id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'lark', workspaceId: 'moic', title: 'How many workers? (+1 more)', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 2, questions }, forwardedFrom: null };

    it('a complete form becomes one answer-question command with the selections and the notes per question', () => {
        expect(resolveDeckForm(item, [['4'], ['unit', 'smoke']], ['go easy on the db', ''])).toEqual({ kind: 'answer-question', questionId: 'q_1', selections: [['4'], ['unit', 'smoke']], notes: ['go easy on the db', ''], note: '' });
        // An overall note from a caller other than the form still travels.
        expect(resolveDeckForm(item, [['4'], ['unit']], ['', ''], 'overall')).toMatchObject({ kind: 'answer-question', note: 'overall' });
    });

    it('a NOTE ALONE answers its question — the option may be left empty', () => {
        expect(resolveDeckForm(item, [['4'], []], ['', 'none of these — run the perf suite'])).toEqual({ kind: 'answer-question', questionId: 'q_1', selections: [['4'], []], notes: ['', 'none of these — run the perf suite'], note: '' });
    });

    it('a question with NEITHER an option nor a note is refused by name, with what it needs', () => {
        expect(resolveDeckForm(item, [[], ['unit']], ['', ''])).toEqual({ kind: 'refused', reason: 'Workers needs an option or a note' });
        // A blank note is no note.
        expect(resolveDeckForm(item, [['4'], []], ['', '  \n '])).toEqual({ kind: 'refused', reason: 'Scope needs an option or a note' });
        // An overall note does not answer a question: the per-question rule is the rule.
        expect(resolveDeckForm(item, [[], ['unit']], ['', ''], 'overall')).toEqual({ kind: 'refused', reason: 'Workers needs an option or a note' });
    });

    it('refuses two picks on a single-select (even with a note), a label that is not an option, more notes than questions, or an item that is not a form — each with the reason', () => {
        expect(resolveDeckForm(item, [['4', '8'], ['unit']], ['why both', ''])).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/Workers takes one answer/) });
        expect(resolveDeckForm(item, [['4'], ['nope']], ['', ''])).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/nope/) });
        expect(resolveDeckForm(item, [['4'], ['unit']], ['', '', 'stray'])).toMatchObject({ kind: 'refused', reason: '2 questions, 3 notes' });
        expect(resolveDeckForm({ ...item, answer: { kind: 'inline', options: [] } }, [['4']], [''])).toMatchObject({ kind: 'refused' });
        // An item minted before the questions travelled cannot be answered as a form — refused with the route (the agent), never guessed.
        expect(resolveDeckForm({ ...item, answer: { kind: 'form', fields: 2 } }, [['4'], ['unit']], ['', ''])).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/did not carry its questions/) });
        // Forwarded: never answered here.
        expect(resolveDeckForm({ ...item, forwardedFrom: 'studio' }, [['4'], ['unit']], ['', ''])).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/studio/) });
    });
});
