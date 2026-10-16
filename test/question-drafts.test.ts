import { describe, expect, it } from 'vitest';
import { activeQuestion, dropDraft, mergeDrafts, pruneDrafts, putDraft } from '../src/core/question-drafts.js';

/**
 * THE WINDOW'S DRAFTS, AS RULES (core/question-drafts.ts — Genie 1's renderer/lib/ask-state.ts, carried over): a pushed
 * view never overwrites what the person is typing; the question they picked stays picked while it is asked. New module:
 * on origin/main this file is red because the module does not exist; the window's behaviour on origin/main is red by
 * assertion in ftq-queue.test.tsx.
 */
const typing = { selections: [['B']], notes: ['use the staging one'] };
const older = { selections: [['B']], notes: ['use the sta'] };

describe('a push while the person types', () => {
    it('the window’s own draft wins over main’s older copy; main fills a question the window has none for; exact values', () => {
        const merged = mergeDrafts({ q_kai: typing }, { q_kai: older, q_wren: { selections: [[]], notes: ['later today'] } }, ['q_kai', 'q_wren']);
        expect(merged).toEqual({ q_kai: typing, q_wren: { selections: [[]], notes: ['later today'] } });
    });

    it('a question gone from the queue drops its draft — counted: one left of two', () => {
        const merged = mergeDrafts({ q_kai: typing, q_gone: older }, {}, ['q_kai', 'q_wren']);
        expect(Object.keys(merged)).toEqual(['q_kai']);
    });

    it('put / drop / prune touch only the question named', () => {
        const one = putDraft({}, 'q_kai', typing);
        const two = putDraft(one, 'q_wren', older);
        expect(dropDraft(two, 'q_wren')).toEqual({ q_kai: typing });
        expect(pruneDrafts(two, ['q_wren'])).toEqual({ q_wren: older });
        // Control: nothing to prune hands back the same object (no re-render for nothing).
        expect(pruneDrafts(two, ['q_kai', 'q_wren'])).toBe(two);
    });
});

describe('which question is in front of the person', () => {
    it('their pick, while it is still asked — an arrival does not move it', () => {
        expect(activeQuestion({ picked: 'q_wren', shown: 'q_kai', queue: ['q_kai', 'q_wren', 'q_new'] })).toBe('q_wren');
    });
    it('their pick answered elsewhere: main’s choice; nothing shown: the first in the queue', () => {
        expect(activeQuestion({ picked: 'q_wren', shown: 'q_kai', queue: ['q_kai'] })).toBe('q_kai');
        expect(activeQuestion({ picked: null, shown: null, queue: ['q_kai', 'q_wren'] })).toBe('q_kai');
        expect(activeQuestion({ picked: null, shown: null, queue: [] })).toBeNull();
    });
});
