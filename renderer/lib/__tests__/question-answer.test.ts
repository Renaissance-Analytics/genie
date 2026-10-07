import { describe, expect, it } from 'vitest';
import {
    answerableOnDeck,
    blankAnswerState,
    buildAnswer,
    answerIsComplete,
    type AnswerState,
} from '../question-answer';
import type { PendingQuestionSpec } from '../genie';

/**
 * Answering ANY question from the Deck — not just the one-click kind.
 *
 * ## Why this exists
 *
 * The Genie 2 plan lists `QuestionInboxFlyout` under P7's deletions as *"chrome only — all
 * logic kept"*. Measured, that is wrong: `inlineAnswerable` deliberately excludes multi-part,
 * multi-select, free-text and forwarded questions, and its reasoning is sound —
 *
 * > *"one click cannot express 'these two of four'… a free-text question has no button that
 * > could answer it; offering one would send an empty note."*
 *
 * So the flyout is not redundant chrome; it is the ONLY surface that answers everything the
 * Deck refuses inline. Deleting it as written would strand multi-select, multi-part and
 * free-text answers entirely. This module is what has to exist first: the Deck can answer
 * everything, and then the flyout is genuinely redundant.
 *
 * ## What is still refused, and why that is not a gap
 *
 * A FORWARDED question is answered on its own host. Resolving the local copy would mark it
 * done here while the real one waits forever on the machine that asked.
 */

const q = (over: Partial<PendingQuestionSpec> = {}): PendingQuestionSpec => ({
    id: 'q1',
    index: 0,
    questions: [
        { header: 'Engine', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
    ],
    ...over,
});

const multi = q({
    questions: [
        {
            header: 'Caps',
            question: 'Which caps?',
            multiSelect: true,
            options: [{ label: 'cost' }, { label: 'turns' }, { label: 'time' }],
        },
    ],
});

const twoPart = q({
    questions: [
        { header: 'One', question: 'First?', options: [{ label: 'yes' }, { label: 'no' }] },
        { header: 'Two', question: 'Second?', options: [{ label: 'up' }, { label: 'down' }] },
    ],
});

const freeText = q({ questions: [{ header: 'Why', question: 'Why?', options: [] }] });

describe('answerableOnDeck', () => {
    it('accepts the simple single-select the Deck already handled', () => {
        expect(answerableOnDeck(q())).toBe(true);
    });

    it('accepts MULTI-SELECT, which the inline path refused', () => {
        expect(answerableOnDeck(multi)).toBe(true);
    });

    it('accepts a MULTI-PART question, which the inline path refused', () => {
        expect(answerableOnDeck(twoPart)).toBe(true);
    });

    it('accepts a FREE-TEXT question with no options at all', () => {
        expect(answerableOnDeck(freeText)).toBe(true);
    });

    it('still REFUSES a forwarded question', () => {
        // Answered on its own host. Resolving the local copy marks it done here while the
        // real one waits forever on the machine that asked.
        expect(answerableOnDeck(q({ remoteHost: 'rig-2' }))).toBe(false);
    });

    it('refuses a question with no parts, which cannot be answered at all', () => {
        expect(answerableOnDeck(q({ questions: [] }))).toBe(false);
    });
});

describe('blankAnswerState', () => {
    it('has one slot per part, so a two-part question cannot answer only half', () => {
        expect(blankAnswerState(twoPart)).toEqual([
            { selected: [], note: '' },
            { selected: [], note: '' },
        ]);
    });
});

describe('answerIsComplete', () => {
    it('needs a choice for a single-select part', () => {
        expect(answerIsComplete(q(), [{ selected: [], note: '' }])).toBe(false);
        expect(answerIsComplete(q(), [{ selected: ['A'], note: '' }])).toBe(true);
    });

    it('needs EVERY part answered, not just the first', () => {
        // The defect the inline path avoided by refusing multi-part outright: the agent
        // carries on with three quarters of a decision and nothing says so.
        const half: AnswerState[] = [
            { selected: ['yes'], note: '' },
            { selected: [], note: '' },
        ];
        expect(answerIsComplete(twoPart, half)).toBe(false);
        expect(
            answerIsComplete(twoPart, [
                { selected: ['yes'], note: '' },
                { selected: ['up'], note: '' },
            ]),
        ).toBe(true);
    });

    it('accepts ONE selection on a multi-select, because one of three is a real answer', () => {
        expect(answerIsComplete(multi, [{ selected: ['cost'], note: '' }])).toBe(true);
    });

    it('accepts several selections on a multi-select', () => {
        expect(answerIsComplete(multi, [{ selected: ['cost', 'turns'], note: '' }])).toBe(true);
    });

    it('takes a NOTE as a complete answer to a free-text part', () => {
        // There is no option to click, so the note is the answer. Requiring a selection
        // would make the question unanswerable.
        expect(answerIsComplete(freeText, [{ selected: [], note: '' }])).toBe(false);
        expect(answerIsComplete(freeText, [{ selected: [], note: 'because' }])).toBe(true);
    });

    it('accepts a note ALONE even when options exist', () => {
        // The modal always offers free text beside the options, and an answer that declines
        // every option and explains why is a real answer — often the most useful one.
        expect(answerIsComplete(q(), [{ selected: [], note: 'neither, here is why' }])).toBe(true);
    });

    it('ignores whitespace, so a space bar is not an answer', () => {
        expect(answerIsComplete(freeText, [{ selected: [], note: '   ' }])).toBe(false);
    });
});

describe('buildAnswer', () => {
    it('shapes one part into the answer the host expects', () => {
        expect(buildAnswer(q(), [{ selected: ['A'], note: '' }])).toEqual([
            { header: 'Engine', question: 'Which?', selected: ['A'], note: '' },
        ]);
    });

    it('carries EVERY selection on a multi-select', () => {
        expect(buildAnswer(multi, [{ selected: ['cost', 'time'], note: '' }])).toEqual([
            { header: 'Caps', question: 'Which caps?', selected: ['cost', 'time'], note: '' },
        ]);
    });

    it('shapes every part of a multi-part question, in order', () => {
        const answers = buildAnswer(twoPart, [
            { selected: ['no'], note: '' },
            { selected: ['down'], note: 'reluctantly' },
        ])!;
        expect(answers).toHaveLength(2);
        expect(answers[0]).toMatchObject({ header: 'One', selected: ['no'] });
        expect(answers[1]).toMatchObject({ header: 'Two', selected: ['down'], note: 'reluctantly' });
    });

    it('trims the note, so trailing whitespace is not sent as content', () => {
        expect(buildAnswer(freeText, [{ selected: [], note: '  because  ' }])![0]!.note).toBe('because');
    });

    it('REFUSES an incomplete answer rather than sending a partial', () => {
        // The whole reason `inlineAnswerable` existed. A partial answer is worse than none:
        // the agent proceeds on three quarters of a decision and nothing marks it.
        expect(buildAnswer(twoPart, [{ selected: ['yes'], note: '' }, { selected: [], note: '' }])).toBeNull();
    });

    it('REFUSES a forwarded question even with a complete-looking answer', () => {
        expect(buildAnswer(q({ remoteHost: 'rig-2' }), [{ selected: ['A'], note: '' }])).toBeNull();
    });

    it('REFUSES a selection that is not one of the offered options', () => {
        // A label that is not on the question cannot have been chosen by a human reading it,
        // so it is a bug in the caller rather than an answer to pass on.
        expect(buildAnswer(q(), [{ selected: ['Z'], note: '' }])).toBeNull();
    });

    it('REFUSES when the state has the wrong number of parts', () => {
        // A state built for a different question — the shape of a stale render answering the
        // question that replaced it.
        expect(buildAnswer(twoPart, [{ selected: ['yes'], note: '' }])).toBeNull();
    });
});
