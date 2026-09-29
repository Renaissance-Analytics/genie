import { describe, expect, it } from 'vitest';
import { validateForceQuestions } from '../question-input';

/**
 * A QUESTION NOBODY CAN ANSWER MUST NOT REACH THE SCREEN.
 *
 * The owner, with a screenshot of the modal and then a second one of the
 * Questions flyout: a question whose prose rendered perfectly above a column of
 * blank pills, in both surfaces, with no way to answer it. The chip was empty
 * and every option was empty.
 *
 * The declared schema had always required `header`, `question`, `options` and a
 * `label` on each option. Nothing enforced any of it — the handler checked that
 * `questions` was a non-empty array and cast the rest — so any shape reached the
 * renderer, which read `o.label` off whatever it was handed and drew `undefined`
 * as nothing.
 *
 * Which exact malformation arrived that day cannot be recovered: dismissing the
 * question deleted its stored row before it could be read (fixed separately).
 * That is precisely why this validates the SHAPE rather than guessing at one
 * client's mistake — every way of getting it wrong ends in the same blank modal,
 * and every one of them is refused here with the path that was wrong.
 *
 * ## Refuse, don't repair
 *
 * Coercing `["Yes","No"]` into two labels would hide the mistake from the only
 * party that can fix it. The agent gets its call back naming the bad path and
 * what arrived, which it can correct in one turn.
 */
const ok = (header: string) => ({
    header,
    question: `${header}?`,
    options: [{ label: 'Yes' }, { label: 'No' }],
});

/** The error text, or a failure if it unexpectedly validated. */
function refusal(raw: unknown): string {
    const r = validateForceQuestions(raw);
    if (!('error' in r)) throw new Error('expected a refusal, got a valid payload');
    return r.error;
}

describe('a well-formed payload passes through untouched', () => {
    it('THE CONTROL — accepts a valid question and returns it as given', () => {
        // Everything below asserts a refusal, and a validator that refused
        // EVERYTHING would satisfy all of them. This is what makes them mean
        // something.
        const raw = [ok('Ship')];
        const r = validateForceQuestions(raw);

        expect('error' in r).toBe(false);
        expect((r as { questions: unknown[] }).questions).toBe(raw);
    });

    it('accepts the optional fields the schema allows', () => {
        const r = validateForceQuestions([
            {
                header: 'Ship',
                question: 'Ship it?',
                multiSelect: true,
                options: [{ label: 'Yes', description: 'Go now' }, { label: 'No' }],
            },
        ]);

        expect('error' in r).toBe(false);
    });

    it('does not impose the schema’s COUNTS, which are guidance', () => {
        // 1–4 questions and 2–4 options are good advice, and neither makes a
        // modal unanswerable. Enforcing them would refuse working callers
        // without preventing a single blank pill.
        expect('error' in validateForceQuestions([{ ...ok('A'), options: [{ label: 'Only' }] }]))
            .toBe(false);
        expect('error' in validateForceQuestions([ok('A'), ok('B'), ok('C'), ok('D'), ok('E')]))
            .toBe(false);
    });
});

describe('the blank-pill payloads', function () {
    it('refuses options given as bare strings, and says what they should be', () => {
        // The likeliest mistake, and the one that renders exactly the reported
        // modal: labels come back `undefined`, so every pill is empty.
        const msg = refusal([{ header: 'Ship', question: 'Ship it?', options: ['Yes', 'No'] }]);

        expect(msg).toContain('questions[0].options[0]');
        expect(msg).toContain('"Yes"');
        expect(msg).toMatch(/not bare strings/i);
    });

    it('refuses an option object with no label', () => {
        const msg = refusal([
            { header: 'Ship', question: 'Ship it?', options: [{ label: 'Yes' }, { title: 'No' }] },
        ]);

        expect(msg).toContain('questions[0].options[1].label');
        expect(msg).toContain('nothing');
    });

    it('refuses a label that is present but blank', () => {
        // An empty string passes a naive `'label' in o` check and still draws a
        // button with nothing on it.
        const msg = refusal([
            { header: 'Ship', question: 'Ship it?', options: [{ label: '   ' }, { label: 'No' }] },
        ]);

        expect(msg).toContain('questions[0].options[0].label');
        expect(msg).toContain('empty string');
    });

    it('refuses a missing header — the empty chip in the screenshot', () => {
        const msg = refusal([{ question: 'Ship it?', options: [{ label: 'Yes' }] }]);

        expect(msg).toContain('questions[0].header');
    });

    it('refuses a missing question body', () => {
        expect(refusal([{ header: 'Ship', options: [{ label: 'Yes' }] }])).toContain(
            'questions[0].question',
        );
    });

    it('refuses options that are missing entirely, or not a list', () => {
        expect(refusal([{ header: 'Ship', question: 'Ship it?' }])).toContain(
            'questions[0].options',
        );
        expect(
            refusal([{ header: 'Ship', question: 'Ship it?', options: { label: 'Yes' } }]),
        ).toContain('questions[0].options');
    });

    it('names the RIGHT question when a later one is at fault', () => {
        // A payload is refused whole, so the index has to be right or an agent
        // fixes the wrong question and gets refused again.
        const msg = refusal([ok('Fine'), { ...ok('Broken'), options: ['nope'] }]);

        expect(msg).toContain('questions[1].options[0]');
        expect(msg).not.toContain('questions[0]');
    });
});

describe('payloads that are not questions at all', () => {
    it('keeps the original empty/non-array refusal', () => {
        expect(refusal([])).toMatch(/non-empty `questions` array/);
        expect(refusal(undefined)).toMatch(/non-empty `questions` array/);
        expect(refusal('Ship it?')).toMatch(/non-empty `questions` array/);
    });

    it('refuses a string where a question object belongs', () => {
        expect(refusal(['Ship it?'])).toContain('questions[0] must be an object');
    });

    it('refuses null without throwing on it', () => {
        expect(refusal([null])).toContain('questions[0] must be an object');
    });
});

describe('the message an agent gets back', () => {
    it('reports the VALUE that arrived, not just its type', () => {
        // "received a string" leaves an agent guessing which option was wrong.
        expect(refusal([{ header: 'Ship', question: 'Ship it?', options: ['Maybe'] }])).toContain(
            '"Maybe"',
        );
    });

    it('truncates a long value rather than pasting it into the error', () => {
        const long = 'x'.repeat(500);
        const msg = refusal([{ header: 'Ship', question: 'Ship it?', options: [long] }]);

        expect(msg).toContain('…');
        expect(msg.length).toBeLessThan(400);
    });
});
