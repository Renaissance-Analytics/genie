import { describe, expect, it } from 'vitest';
import {
    dropDraft,
    parseDraftStore,
    pruneDrafts,
    putDraft,
    serializeDraftStore,
    type AskDraftStore,
} from '../draft-store';

/**
 * A part-typed answer must survive the surface being closed.
 *
 * `renderer/lib/ask-state.ts` already states the rule — "a draft belongs to the
 * QUESTION, not to the modal" — but it only held while a component stayed
 * mounted, and neither surface does:
 *
 *  - the ForceTheQuestion window is a separate BrowserWindow that main CLOSES
 *    when the queue drains (`force-question.ts:496`), destroying its renderer
 *    state outright;
 *  - the in-app question flyout returns `null` when shut
 *    (`QuestionInboxFlyout.tsx:157`), so its per-question `selected`/`note` state
 *    unmounts with it.
 *
 * So someone who picks two options, starts typing a note, and steps away to
 * check something comes back to a blank form. That is the friction this store
 * removes: drafts live in main, keyed by question id, shared by both surfaces
 * and outliving either one.
 */
describe('the ask draft store', () => {
    const draft = (note: string) => ({ selected: { 0: ['Yes'] }, notes: { 0: note } });

    it('keeps a draft that was put under a question id', () => {
        const store = putDraft({}, 'q1', draft('half a thought'));
        expect(store.q1?.notes[0]).toBe('half a thought');
    });

    it('replaces a draft rather than merging into a stale one', () => {
        // Deselecting an option has to be able to REMOVE it. A merge would make
        // selections one-way and un-untickable.
        const store = putDraft(putDraft({}, 'q1', draft('first')), 'q1', {
            selected: {},
            notes: { 0: 'second' },
        });
        expect(store.q1).toEqual({ selected: {}, notes: { 0: 'second' } });
    });

    it('keeps drafts for different questions apart', () => {
        const store = putDraft(putDraft({}, 'q1', draft('one')), 'q2', draft('two'));
        expect(store.q1?.notes[0]).toBe('one');
        expect(store.q2?.notes[0]).toBe('two');
    });

    it('drops a draft once its question is answered', () => {
        const store = dropDraft(putDraft({}, 'q1', draft('done with this')), 'q1');
        expect(store.q1).toBeUndefined();
    });

    it('prunes drafts whose questions are no longer pending', () => {
        // Questions get retracted, answered on the phone, or resolved by the
        // host first. Without this the store grows forever and a recycled id
        // would surface a stranger's half-answer.
        const store = putDraft(putDraft({}, 'live', draft('keep')), 'gone', draft('bin'));
        const pruned = pruneDrafts(store, ['live']);
        expect(pruned.live).toBeDefined();
        expect(pruned.gone).toBeUndefined();
    });

    it('prunes to nothing when nothing is pending', () => {
        expect(pruneDrafts(putDraft({}, 'q1', draft('x')), [])).toEqual({});
    });

    it('round-trips through storage', () => {
        const store = putDraft({}, 'q1', draft('survives a restart'));
        expect(parseDraftStore(serializeDraftStore(store))).toEqual(store);
    });

    it('treats unreadable storage as no drafts, never as a crash', () => {
        // This is read on the path that SHOWS a question. A parse error here
        // must not be able to stop the modal appearing at all — losing a draft
        // is bad, losing the question is worse.
        expect(parseDraftStore('{not json')).toEqual({});
        expect(parseDraftStore(undefined)).toEqual({});
        expect(parseDraftStore('null')).toEqual({});
        expect(parseDraftStore('[1,2,3]')).toEqual({});
    });

    it('discards entries that are not shaped like a draft', () => {
        const parsed: AskDraftStore = parseDraftStore(
            '{"good":{"selected":{},"notes":{"0":"ok"}},"bad":"nope","alsoBad":null}',
        );
        expect(parsed.good?.notes[0]).toBe('ok');
        expect(parsed.bad).toBeUndefined();
        expect(parsed.alsoBad).toBeUndefined();
    });
});
