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
 * SAME unhovered row differ by. The hover was absent from the picture entirely,
 * and the bound had been placed three pixels above that noise instead of between
 * it and the real signal.
 */

/** What a missed hover actually measured on CI. */
const MISSED = 97;

/**
 * What the row's own chrome is worth, per platform, measured on CI.
 *
 * These are `differingPixels(cU, eU)` — the sparkline's contribution — and they
 * are here because they are the reason this file has a SMALL floor. They
 * disagree by 14×, so no single absolute number describes "a visible change to
 * this row" on every platform, and an earlier floor of 1,000 chosen from the
 * largest of them failed macOS on a healthy row.
 */
const SPARKLINE_BY_PLATFORM = { macos: 564, ubuntu: 7_808, windows: 7_838 };

describe('the bound never weakens what shipped', () => {
    it('is at least the old bound, whatever the noise measures', () => {
        expect(hoverCaptureBound(0)).toBe(HOVER_FILL_FLOOR);
        expect(HOVER_FILL_FLOOR).toBe(100);
        for (const jitter of [0, 1, 10, 33]) {
            expect(hoverCaptureBound(jitter)).toBeGreaterThanOrEqual(100);
        }
    });

    it('stays under the smallest real signal any platform produces', () => {
        // The floor must not exceed what a healthy row is worth on its SMALLEST
        // platform, or the guard fails where nothing is wrong. This is the
        // assertion that would have caught the 1,000 floor before CI did.
        for (const measured of Object.values(SPARKLINE_BY_PLATFORM)) {
            expect(HOVER_FILL_FLOOR).toBeLessThan(measured);
        }
    });
});

describe('a landed hover is separated from a missed one', () => {
    it('rejects the exact number CI produced for a missed hover', () => {
        expect(hoverWasCaptured({ jitter: MISSED, hovered: MISSED })).toBe(false);
    });

    it('accepts a hover worth even the SMALLEST platform’s row chrome', () => {
        // Positive control, and deliberately sized to macOS's 564 rather than to
        // the comfortable 7,800: a guard that only passes on the generous
        // platforms is the bug this file already shipped once.
        expect(
            hoverWasCaptured({ jitter: 20, hovered: SPARKLINE_BY_PLATFORM.macos }),
        ).toBe(true);
    });
});

describe('the RATIO is what detects a row that stopped restyling', () => {
    it('refuses a hovered frame that has collapsed to the noise floor', () => {
        // THE POINT OF THE WHOLE FILE. If the row stops painting its fill, the
        // hovered frame photographs like the unhovered one, so `hovered` falls
        // to `jitter` — and a multiple of the measured noise catches that at any
        // magnitude, on any platform, without knowing what the fill is worth.
        for (const jitter of [12, 97, 400, 7_625]) {
            expect(hoverWasCaptured({ jitter, hovered: jitter })).toBe(false);
        }
    });

    it('scales with a noisy frame, so size alone is not evidence', () => {
        expect(hoverCaptureBound(400)).toBe(400 * JITTER_RATIO);
        expect(hoverWasCaptured({ jitter: 400, hovered: 1_000 })).toBe(false);
        // Positive control: the same noisy frame DOES accept a real hover.
        expect(hoverWasCaptured({ jitter: 400, hovered: 40_000 })).toBe(true);
    });

    it('is not vacuous on a perfectly still frame', () => {
        // Zero noise would collapse a pure ratio to zero and pass anything.
        expect(hoverWasCaptured({ jitter: 0, hovered: 50 })).toBe(false);
        expect(hoverWasCaptured({ jitter: 0, hovered: 5_000 })).toBe(true);
    });
});

describe('the failure says what was measured', () => {
    it('names both numbers and the bound they were judged against', () => {
        const message = describeHoverCapture({ jitter: MISSED, hovered: MISSED });
        expect(message).toContain(String(MISSED));
        expect(message).toContain(String(hoverCaptureBound(MISSED)));
        expect(message).toMatch(/noise/i);
    });

    it('reads as a MEASUREMENT failure, and names the other possibility too', () => {
        // The distinction is the point of genie#518: a hover that never reached
        // the photograph says nothing about whether the row restyles on hover.
        // But the message must not hide the case where it IS the row's fault.
        const message = describeHoverCapture({ jitter: MISSED, hovered: MISSED });
        expect(message).toMatch(/measurement failure/i);
        expect(message).toMatch(/stopped painting/i);
    });
});
