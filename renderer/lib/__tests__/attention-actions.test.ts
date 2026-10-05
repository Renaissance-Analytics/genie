import { describe, expect, it } from 'vitest';
import { answerForOption, inlineAnswerable } from '../attention-actions';
import type { PendingQuestionSpec } from '../genie';

/**
 * What a Deck row can actually RESOLVE without opening anything.
 *
 * The temptation is to put buttons on everything. The rule that stops it: a row may only
 * offer an inline answer when answering inline is the WHOLE answer. A ForceTheQuestion
 * can carry up to four sub-questions, each with its own options and free text — rendering
 * the first one's buttons would submit a partial answer and tell the agent the human had
 * decided, which is worse than making them open the modal.
 */

const q = (over: Partial<PendingQuestionSpec> = {}): PendingQuestionSpec => ({
    id: 'q1',
    index: 0,
    questions: [
        {
            header: 'Migrate?',
            question: 'Migrate the pulse ring, or dual-write?',
            options: [{ label: 'Dual-write' }, { label: 'Migrate now' }],
        },
    ],
    ...over,
});

describe('inlineAnswerable', () => {
    it('allows a single question with options', () => {
        expect(inlineAnswerable(q())).toBe(true);
    });

    it('REFUSES a question with more than one part', () => {
        // Answering the first part would submit a partial answer and unblock the agent as
        // though the human had decided everything.
        const multi = q({
            questions: [
                { header: 'A', question: 'a?', options: [{ label: 'yes' }] },
                { header: 'B', question: 'b?', options: [{ label: 'no' }] },
            ],
        });
        expect(inlineAnswerable(multi)).toBe(false);
    });

    it('refuses a question with no options, because that one wants prose', () => {
        // A free-text question has no button that could answer it. Offering one would mean
        // sending an empty note.
        expect(inlineAnswerable(q({ questions: [{ header: 'Why', question: 'why?', options: [] }] }))).toBe(false);
    });

    it('refuses a multi-select question', () => {
        // One click cannot express "these two of four", and submitting a single choice
        // would under-answer it.
        expect(
            inlineAnswerable(
                q({
                    questions: [
                        { header: 'Which', question: 'which?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
                    ],
                }),
            ),
        ).toBe(false);
    });

    it('refuses a question with no parts at all', () => {
        expect(inlineAnswerable(q({ questions: [] }))).toBe(false);
    });

    it('refuses a question forwarded from another host', () => {
        // It is answered on its own host through the forwarding path. Answering it here
        // would resolve a local copy and leave the real one waiting.
        expect(inlineAnswerable(q({ remoteHost: 'studio' }))).toBe(false);
    });
});

describe('answerForOption', () => {
    it('builds the answer the host expects, naming the chosen option', () => {
        expect(answerForOption(q(), 'Migrate now')).toEqual([
            {
                header: 'Migrate?',
                question: 'Migrate the pulse ring, or dual-write?',
                selected: ['Migrate now'],
                note: '',
            },
        ]);
    });

    it('refuses an option the question does not offer', () => {
        // A stale row after the question changed. Submitting an invented option would be
        // answering on the human's behalf.
        expect(answerForOption(q(), 'Something else')).toBeNull();
    });

    it('refuses when the question is not inline-answerable in the first place', () => {
        const multi = q({
            questions: [
                { header: 'A', question: 'a?', options: [{ label: 'yes' }] },
                { header: 'B', question: 'b?', options: [{ label: 'no' }] },
            ],
        });
        expect(answerForOption(multi, 'yes')).toBeNull();
    });
});
