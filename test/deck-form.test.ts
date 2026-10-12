import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { resolveDeckForm } from '../src/core/deck-resolve.js';

/**
 * A MULTI-PART QUESTION IS ANSWERED IN PLACE (§4.5): "A multi-part, multi-select or free-text question expands into a
 * full form in place." The board audit of 2026-10-12 found "Answer N questions" navigating to the agent's stream. Now
 * the Deck item carries the questions themselves, and `resolveDeckForm` turns the filled form into the one answer the
 * attention store takes — one selection per single-select question, at least one per multi-select, every label one of
 * that question's options, the free-text note always allowed — or a refusal that says what is missing.
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

describe('resolveDeckForm', () => {
    const item: DeckItem = { id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'lark', workspaceId: 'moic', title: 'How many workers? (+1 more)', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 2, questions }, forwardedFrom: null };

    it('a complete form becomes one answer-question command with the selections per question and the note', () => {
        expect(resolveDeckForm(item, [['4'], ['unit', 'smoke']], 'go easy on the db')).toEqual({ kind: 'answer-question', questionId: 'q_1', selections: [['4'], ['unit', 'smoke']], note: 'go easy on the db' });
    });

    it('refuses an unanswered question, two picks on a single-select, a label that is not an option, or an item that is not a form — each with the reason', () => {
        expect(resolveDeckForm(item, [[], ['unit']], '')).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/Workers/) });
        expect(resolveDeckForm(item, [['4', '8'], ['unit']], '')).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/one answer/) });
        expect(resolveDeckForm(item, [['4'], ['nope']], '')).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/nope/) });
        expect(resolveDeckForm({ ...item, answer: { kind: 'inline', options: [] } }, [['4']], '')).toMatchObject({ kind: 'refused' });
        // An item minted before the questions travelled cannot be answered as a form — refused with the route (the agent), never guessed.
        expect(resolveDeckForm({ ...item, answer: { kind: 'form', fields: 2 } }, [['4'], ['unit']], '')).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/did not carry its questions/) });
        // Forwarded: never answered here.
        expect(resolveDeckForm({ ...item, forwardedFrom: 'studio' }, [['4'], ['unit']], '')).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/studio/) });
    });
});
