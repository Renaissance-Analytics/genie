import { describe, expect, it } from 'vitest';
import { inboxNoticeText } from '../notify';

/**
 * An answer to YOUR question is not "a message from you".
 *
 * A ForceTheQuestion answer came back through the ordinary inbox notice:
 *
 *   [Genie] You just received a message from You as a DM, marked HIGH PRIORITY…
 *
 * Two things are wrong with that. It reads as a note the agent sent ITSELF —
 * "from You", DM'd — when it is in fact the human answering a question the
 * agent asked and is blocked on. And it is indistinguishable from any other
 * DM, so an agent cannot tell "someone said hello" from "the decision you were
 * waiting for has arrived".
 *
 * The answer gets its own shape: it names the USER as the source, says it is
 * the answer to a question this agent asked, and keeps the "how to read it"
 * half that makes any notice actionable.
 */

describe('the notice for a ForceTheQuestion answer', () => {
    const answer = inboxNoticeText({ from: 'You', priority: 'high', kind: 'ftq-answer', mode: 'manual' });

    it('says it is the ANSWER to a question this agent asked', () => {
        expect(answer).toMatch(/answered/i);
        expect(answer).toMatch(/question/i);
    });

    it('does not read as a message the agent sent itself', () => {
        // The reported symptom: "a message from You as a DM" looks like a
        // note-to-self, not the human unblocking you.
        expect(answer).not.toMatch(/message from You/i);
        expect(answer).not.toMatch(/as a DM/i);
    });

    it('names the user as the source', () => {
        expect(answer).toMatch(/\buser\b/i);
    });

    it('still says how to read it', () => {
        // A notice that does not say how to open the thing is just noise.
        expect(answer).toContain('agentinbox');
        expect(answer).toContain('receive');
    });

    it('leaves an ordinary DM notice exactly as it was', () => {
        // POSITIVE CONTROL: this must not rewrite every notice in the product.
        const dm = inboxNoticeText({ from: 'claude · tynn', priority: 'normal', mode: 'manual' });

        expect(dm).toContain('You just received a message from claude · tynn as a DM');
        expect(dm).toContain('It is not urgent');
    });

    it('leaves a channel notice exactly as it was', () => {
        const chan = inboxNoticeText({ from: 'someone', priority: 'high', channel: 'build', mode: 'manual' });

        expect(chan).toContain('in the #build channel');
    });
});
