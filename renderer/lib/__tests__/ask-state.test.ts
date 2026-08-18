import { describe, expect, it } from 'vitest';
import {
    clearDraft,
    draftFor,
    draftToAnswers,
    isDraftReady,
    resolveActiveQuestionId,
    setDraftNote,
    toggleDraftOption,
    type AskDrafts,
} from '../ask-state';

/**
 * ForceTheQuestion modal state (genie#156).
 *
 * The modal shows ONE question at a time out of a multi-agent queue, and the user
 * can pin a queued one to answer next. Two things must hold, because an agent can
 * change the queue at any moment while the user is typing:
 *
 *  1. A pin the user made is THEIRS until that question is gone — a question
 *     arriving or the head advancing must not silently swap what they're looking at.
 *  2. A half-typed answer belongs to the QUESTION, not to the modal — so nothing
 *     that happens to the queue can wipe it, and switching away and back keeps it.
 *
 * The renderer has no jsdom harness, so the judgement lives here as pure functions
 * and `ask.tsx` is a thin shell over them.
 */

describe('resolveActiveQuestionId', () => {
    it('follows the head when the user has not pinned anything', () => {
        expect(
            resolveActiveQuestionId({ pinnedId: null, headId: 'a', pendingIds: ['a', 'b'] }),
        ).toBe('a');
    });

    it('keeps the user on the question they pinned, even as the head advances', () => {
        // The user picked queued 'b'; the head moved on to 'c' underneath them.
        expect(
            resolveActiveQuestionId({ pinnedId: 'b', headId: 'c', pendingIds: ['c', 'b'] }),
        ).toBe('b');
    });

    it('keeps the pin when a NEW question arrives (another agent must not yank them)', () => {
        expect(
            resolveActiveQuestionId({ pinnedId: 'b', headId: 'a', pendingIds: ['a', 'b'] }),
        ).toBe('b');
        // …and again after a third agent piles on.
        expect(
            resolveActiveQuestionId({ pinnedId: 'b', headId: 'a', pendingIds: ['a', 'z', 'b'] }),
        ).toBe('b');
    });

    it('falls back to the head once the pinned question is answered/gone', () => {
        expect(
            resolveActiveQuestionId({ pinnedId: 'b', headId: 'a', pendingIds: ['a'] }),
        ).toBe('a');
    });

    it('falls back to the first pending when there is no head yet', () => {
        expect(
            resolveActiveQuestionId({ pinnedId: null, headId: null, pendingIds: ['x', 'y'] }),
        ).toBe('x');
        // A stale pin with no head either → still the first pending.
        expect(
            resolveActiveQuestionId({ pinnedId: 'gone', headId: null, pendingIds: ['x'] }),
        ).toBe('x');
    });

    it('resolves to nothing when nothing is pending and no head has arrived', () => {
        expect(resolveActiveQuestionId({ pinnedId: null, headId: null, pendingIds: [] })).toBeNull();
    });

    it('trusts the head before the queue push lands (they arrive on separate channels)', () => {
        expect(resolveActiveQuestionId({ pinnedId: null, headId: 'a', pendingIds: [] })).toBe('a');
    });
});

describe('answer drafts are keyed by question id', () => {
    it('starts every request with an empty draft', () => {
        expect(draftFor({}, 'a')).toEqual({ selected: {}, notes: {} });
    });

    it('keeps each request’s answer separate, so a forced switch destroys nothing', () => {
        let d: AskDrafts = {};
        d = toggleDraftOption(d, 'a', 0, 'Yes', false);
        d = setDraftNote(d, 'b', 0, 'half-typed thought');

        // Whatever the queue does, both drafts are still there and unmixed.
        expect(draftFor(d, 'a').selected[0]).toEqual(['Yes']);
        expect(draftFor(d, 'a').notes[0]).toBeUndefined();
        expect(draftFor(d, 'b').notes[0]).toBe('half-typed thought');
        expect(draftFor(d, 'b').selected[0]).toBeUndefined();
    });

    it('single-select replaces, and re-picking the same option clears it', () => {
        let d = toggleDraftOption({}, 'a', 0, 'Yes', false);
        d = toggleDraftOption(d, 'a', 0, 'No', false);
        expect(draftFor(d, 'a').selected[0]).toEqual(['No']);
        d = toggleDraftOption(d, 'a', 0, 'No', false);
        expect(draftFor(d, 'a').selected[0]).toEqual([]);
    });

    it('multi-select accumulates and toggles off individually', () => {
        let d = toggleDraftOption({}, 'a', 0, 'Yes', true);
        d = toggleDraftOption(d, 'a', 0, 'No', true);
        expect(draftFor(d, 'a').selected[0]).toEqual(['Yes', 'No']);
        d = toggleDraftOption(d, 'a', 0, 'Yes', true);
        expect(draftFor(d, 'a').selected[0]).toEqual(['No']);
    });

    it('keeps per-question answers within one request apart', () => {
        let d = toggleDraftOption({}, 'a', 0, 'Yes', false);
        d = setDraftNote(d, 'a', 1, 'about the second one');
        expect(draftFor(d, 'a').selected[0]).toEqual(['Yes']);
        expect(draftFor(d, 'a').notes[1]).toBe('about the second one');
    });

    it('never mutates the drafts it is given', () => {
        const before: AskDrafts = { a: { selected: { 0: ['Yes'] }, notes: {} } };
        const after = toggleDraftOption(before, 'a', 0, 'No', true);
        expect(before.a.selected[0]).toEqual(['Yes']); // untouched
        expect(after.a.selected[0]).toEqual(['Yes', 'No']);
    });

    it('clears one request’s draft on submit without touching the others', () => {
        let d = toggleDraftOption({}, 'a', 0, 'Yes', false);
        d = setDraftNote(d, 'b', 0, 'keep me');
        d = clearDraft(d, 'a');
        expect(d.a).toBeUndefined();
        expect(draftFor(d, 'b').notes[0]).toBe('keep me');
    });
});

describe('isDraftReady', () => {
    it('needs an option or a note for EVERY question', () => {
        const d = toggleDraftOption({}, 'a', 0, 'Yes', false);
        expect(isDraftReady(draftFor(d, 'a'), 1)).toBe(true);
        expect(isDraftReady(draftFor(d, 'a'), 2)).toBe(false); // question 2 unanswered
    });

    it('accepts a note alone, but not whitespace', () => {
        expect(isDraftReady(draftFor(setDraftNote({}, 'a', 0, 'because'), 'a'), 1)).toBe(true);
        expect(isDraftReady(draftFor(setDraftNote({}, 'a', 0, '   '), 'a'), 1)).toBe(false);
    });

    it('is never ready for a request with no questions', () => {
        expect(isDraftReady({ selected: {}, notes: {} }, 0)).toBe(false);
    });
});

describe('draftToAnswers', () => {
    const questions = [
        { header: 'Ship', question: 'Ship it?', options: [{ label: 'Yes' }] },
        { header: 'When', question: 'When?', options: [{ label: 'Now' }] },
    ];

    it('answers every question in order, trimming the note', () => {
        let d = toggleDraftOption({}, 'a', 0, 'Yes', false);
        d = setDraftNote(d, 'a', 1, '  after lunch  ');
        expect(draftToAnswers(draftFor(d, 'a'), questions)).toEqual([
            { header: 'Ship', question: 'Ship it?', selected: ['Yes'], note: '' },
            { header: 'When', question: 'When?', selected: [], note: 'after lunch' },
        ]);
    });
});
