import { describe, expect, it } from 'vitest';
import {
    HOVER_FILL_FLOOR,
    JITTER_RATIO,
    describeHoverCapture,
    hoverCaptureBound,
    hoverWasCaptured,
} from '../pulse-hover';

/**
 * Was the row HOVERED in the photograph? (genie#518)
 *
 * The E2E suite cannot stage this. A missed hover happens when the row
 * re-renders between `hover()` and `page.screenshot()` — about once a second, as
 * the pulse ring shifts — and nothing in a spec can make that race land on
 * demand. So the DECISION is here, tested against the numbers CI actually
 * produced, and the spec applies it.
 *
 * The numbers below are real. On PR #516's macOS shard the hovered-vs-unhovered
 * comparison returned **97** against a bound of `> 100`, and the run was read as
 * a marginal threshold. It was not marginal: 97 is what two photographs of the
 * SAME unhovered row differ by when only the polyline has shifted. The hover was
 * absent from the picture entirely, and the bound had been placed three pixels
 * above that noise instead of between it and the real signal.
 */

/** What a missed hover actually measured on CI. */
const MISSED = 97;
/** What the spec's own comment says a landed hover is worth: "thousands". */
const LANDED = 7_000;

describe('a landed hover is separated from a missed one, not adjacent to it', () => {
    it('rejects the exact number CI produced for a missed hover', () => {
        expect(hoverWasCaptured({ jitter: MISSED, hovered: MISSED })).toBe(false);
    });

    it('accepts a hover that repaints the row', () => {
        // Positive control for the case above. Without this, "97 is rejected"
        // would pass just as well against a function that rejects everything.
        expect(hoverWasCaptured({ jitter: MISSED, hovered: LANDED })).toBe(true);
    });

    it('puts the bound BETWEEN the two populations, not at the bottom of the gap', () => {
        const bound = hoverCaptureBound(MISSED);
        expect(bound).toBeGreaterThan(MISSED * 5);
        expect(bound).toBeLessThan(LANDED);
    });
});

describe('the bound is never vacuous', () => {
    it('still refuses a small difference when the frame is perfectly still', () => {
        // A static ring measures zero jitter. A pure ratio would collapse the
        // bound to zero with it and pass anything — which is how an assertion
        // stops testing its own claim. The floor is what stops that.
        expect(hoverCaptureBound(0)).toBe(HOVER_FILL_FLOOR);
        expect(hoverWasCaptured({ jitter: 0, hovered: 500 })).toBe(false);
        expect(hoverWasCaptured({ jitter: 0, hovered: LANDED })).toBe(true);
    });

    it('scales with a NOISY frame, so separation is required and not just size', () => {
        // A frame that jitters by 400 makes 3000 unremarkable: it is under the
        // ratio, so it is not evidence of a hover even though it clears the
        // floor. The two halves of the bound catch different failures.
        expect(hoverCaptureBound(400)).toBe(400 * JITTER_RATIO);
        expect(hoverWasCaptured({ jitter: 400, hovered: 3_000 })).toBe(false);
        expect(hoverWasCaptured({ jitter: 400, hovered: 40_000 })).toBe(true);
    });
});

describe('the failure says what was measured', () => {
    it('names both numbers and the bound they were judged against', () => {
        const message = describeHoverCapture({ jitter: MISSED, hovered: MISSED });
        expect(message).toContain(String(MISSED));
        expect(message).toContain(String(hoverCaptureBound(MISSED)));
        // The next reader must not have to re-derive what 97 meant.
        expect(message).toMatch(/jitter/i);
    });

    it('reads as a MEASUREMENT failure, not a product one', () => {
        // The distinction is the point of genie#518: a hover that never reached
        // the photograph says nothing about whether the row restyles on hover.
        const message = describeHoverCapture({ jitter: MISSED, hovered: MISSED });
        expect(message).toMatch(/hover|photograph/i);
    });
});
