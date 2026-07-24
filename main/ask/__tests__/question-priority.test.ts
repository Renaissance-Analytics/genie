import { describe, expect, it } from 'vitest';
import { insertByPriority, type QuestionPriority } from '../question-priority';

/**
 * PendingQuestions v2 — priority ordering. Higher-priority questions are answered
 * sooner, FIFO within equal priority, and the SHOWN head (index 0, the question the
 * user is currently answering) is NEVER preempted — a higher-priority arrival queues
 * behind it so the user isn't yanked mid-answer.
 */
const item = (id: string, priority?: QuestionPriority) => ({ id, priority });
const ids = (q: Array<{ id: string }>) => q.map((x) => x.id);

describe('insertByPriority (PendingQuestions v2)', () => {
    it('takes the item as the head of an empty queue', () => {
        const q: Array<{ id: string; priority?: QuestionPriority }> = [];
        expect(insertByPriority(q, item('a'))).toBe(0);
        expect(ids(q)).toEqual(['a']);
    });

    it('never preempts the shown head, even for an urgent arrival', () => {
        const q = [item('head', 'normal')];
        expect(insertByPriority(q, item('u', 'urgent'))).toBe(1);
        expect(ids(q)).toEqual(['head', 'u']); // urgent → index 1, NOT 0
    });

    it('orders a higher-priority arrival ahead of waiting lower-priority ones (behind the head)', () => {
        const q = [item('head', 'normal'), item('n1', 'normal')];
        insertByPriority(q, item('u', 'urgent'));
        expect(ids(q)).toEqual(['head', 'u', 'n1']); // before n1, after head
    });

    it('keeps a lower-priority arrival behind existing higher-priority waiters', () => {
        const q = [item('head', 'normal'), item('h', 'high')];
        insertByPriority(q, item('n', 'normal'));
        expect(ids(q)).toEqual(['head', 'h', 'n']);
    });

    it('is FIFO within the same priority', () => {
        const q = [item('head', 'normal')];
        insertByPriority(q, item('n1', 'normal'));
        insertByPriority(q, item('n2', 'normal'));
        expect(ids(q)).toEqual(['head', 'n1', 'n2']);
    });

    it('treats a missing priority as normal', () => {
        const q = [item('head')]; // undefined
        insertByPriority(q, item('hi', 'high'));
        insertByPriority(q, item('n')); // undefined = normal
        expect(ids(q)).toEqual(['head', 'hi', 'n']);
    });
});
