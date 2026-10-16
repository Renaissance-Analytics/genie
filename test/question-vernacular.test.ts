import { describe, expect, it } from 'vitest';
import { validateQuestions, type Question } from '../src/core/attention.js';

/**
 * OPTION VERNACULAR (§6.3): the modal is read by the USER, so an option about who acts names the
 * actor at the front — `Agent: …` or `You: …`. A bare "I'll…" / "You should…" inverts in the
 * reader's mouth and is REFUSED with the fix in the reason. Options that are not about an actor
 * (a plain noun, a choice of value) pass untouched, and so do descriptions.
 */

const q = (labels: string[]): Question[] => [{ header: 'Cadence', question: 'How should runs be grouped?', options: labels.map((label) => ({ label })) }];

describe('validateQuestions: who acts', () => {
    it('accepts actor-named options and neutral options', () => {
        expect(validateQuestions(q(['Agent: batch runs, fewer per hour', 'You: run them yourself']))).toBeNull();
        expect(validateQuestions(q(['Every 10 minutes', 'Every hour', 'Only on request']))).toBeNull();
        expect(validateQuestions(q(['Agent: I will keep going', 'You: you decide later']))).toBeNull();
    });

    it('refuses an option that speaks as I / we / you without naming the actor, and says how to fix it', () => {
        for (const bad of ["I'll keep going", 'I will stop here', 'Let me retry', 'You should do it', 'You do it yourself', 'We continue']) {
            const reason = validateQuestions(q([bad, 'Every hour']));
            expect(reason, bad).toMatch(/names the actor at the front/);
            expect(reason, bad).toMatch(/Agent: … \/ You: …/);
            expect(reason, bad).toContain(bad);
        }
    });

    it('is case-insensitive about the pronoun and tolerant of leading whitespace', () => {
        expect(validateQuestions(q(['  i will do it', 'Every hour']))).toMatch(/names the actor/);
        expect(validateQuestions(q(['YOU pick', 'Every hour']))).toMatch(/names the actor/);
        expect(validateQuestions(q(['Ice cream', 'Youthful']))).toBeNull();
    });
});
