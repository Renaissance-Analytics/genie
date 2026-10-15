import { describe, expect, it } from 'vitest';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { isWindowQuestion } from '../src/core/question-queue.js';
import type { PendingQuestion } from '../src/main/attention-store.js';

/**
 * EVERY QUESTION AN AGENT ASKS IS A FORM (the owner, 2026-10-14: ForceTheQuestion "is a window that opens on top of all
 * other windows", and "I should have a note section for every question asked"). A single single-select question used
 * to become a one-click inline Deck item: no note, and it never opened the window.
 */
const ask = (questions: PendingQuestion['questions']): PendingQuestion => ({
    id: 'q_one', key: 'k', agentId: 'agent_a' as PendingQuestion['agentId'], agentName: 'atlas', workspaceId: 'ws',
    questions, priority: 'normal', askedAt: '2026-10-14T20:00:00.000Z',
});
const items = (q: PendingQuestion) => deckItemsFrom({ questions: [q], userList: [], unreadDms: [], finished: [], agents: {} });

describe('an agent question', () => {
    it('ONE single-select question is a form carrying that question — and so it opens the question window', () => {
        const [item] = items(ask([{ header: 'Probe', question: 'Run it?', options: [{ label: 'Yes' }, { label: 'No' }] }]));
        expect(item!.answer).toEqual({ kind: 'form', fields: 1, questions: [expect.objectContaining({ header: 'Probe' })] });
        expect(isWindowQuestion(item!)).toBe(true);
    });

    it('CONTROL: a multi-question ask was already a form, and still is', () => {
        const [item] = items(ask([
            { header: 'A', question: 'a?', options: [{ label: '1' }, { label: '2' }] },
            { header: 'B', question: 'b?', options: [{ label: '1' }, { label: '2' }], multiSelect: true },
        ]));
        expect(item!.answer.kind).toBe('form');
        expect(isWindowQuestion(item!)).toBe(true);
    });
});
