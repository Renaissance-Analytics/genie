import { describe, expect, it } from 'vitest';
import { reviewNotice } from '../artboard-model';
import type { ReviewDelivery } from '../../../main/artboard/host';

/**
 * What the ArtBoard panel SAYS after a verdict — genie#462.
 *
 * The panel had one boolean and reported a specific cause for it:
 *
 *   "…recorded on the board — but the agent that posted it is no longer
 *    running, so nothing was delivered."
 *
 * It had never checked that. Until genie#456 no post stored a terminal at all,
 * so the sentence was reliably WRONG: every verdict was undelivered and every
 * one blamed an agent that was alive and waiting for it. The owner went looking
 * for an agent-lifecycle problem that did not exist, and the real fault — a
 * post that recorded nowhere to deliver to — stayed hidden behind the story.
 *
 * The host now says which of the three it was, and each one reads as itself.
 * The rule this pins is narrow and absolute: the panel may only name a cause the
 * host established.
 */
const notice = (delivery: ReviewDelivery): string =>
    reviewNotice('Login screen', 'approved', delivery);

describe('reviewNotice', () => {
    it('says the agent was told when it was', () => {
        // POSITIVE CONTROL for every "does not claim X" below: the success
        // sentence is genuinely reachable, so a function that had gone mute
        // about delivery altogether would fail here.
        const said = notice('delivered');
        expect(said).toContain('Login screen');
        expect(said).toContain('approved');
        expect(said).toMatch(/agent has been told/i);
    });

    it('blames a dead agent ONLY when the terminal really has no agent', () => {
        expect(notice('no-agent')).toMatch(/no longer running/i);
    });

    it('does not call a broker refusal a dead agent', () => {
        const said = notice('refused');
        expect(said).not.toMatch(/no longer running/i);
        // …and still says the agent was not reached, so the reviewer is not left
        // reading a plain success.
        expect(said).toMatch(/refused/i);
        expect(said).toMatch(/not been told/i);
    });

    it('names a post with no recorded terminal as the regression it is', () => {
        // After genie#456 every post records the terminal that made it. If this
        // ever reappears, saying "the agent is no longer running" would bury a
        // wiring bug under an agent-lifecycle story for the second time.
        const said = notice('no-terminal');
        expect(said).not.toMatch(/no longer running/i);
        expect(said).toMatch(/terminal/i);
    });

    it('always records the verdict, whatever it says about delivery', () => {
        for (const delivery of ['delivered', 'no-agent', 'refused', 'no-terminal'] as const) {
            const said = reviewNotice('Login screen', 'rejected', delivery);
            expect(said, delivery).toContain('Login screen');
            expect(said, delivery).toContain('rejected');
        }
    });

    it('never claims delivery on any failure', () => {
        for (const delivery of ['no-agent', 'refused', 'no-terminal'] as const) {
            expect(reviewNotice('X', 'approved', delivery), delivery).not.toMatch(
                /agent has been told/i,
            );
        }
    });
});
