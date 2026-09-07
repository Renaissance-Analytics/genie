import { describe, expect, it } from 'vitest';
import {
    HOVER_FILL_FLOOR,
    JITTER_RATIO,
    NOISE_SIGNAL_DIVISOR,
    SPARKLINE_FLOOR,
    describeMeasurement,
    hoverCaptureBound,
    hoverWasCaptured,
    measurementIsUsable,
    noiseWasMeasurable,
} from '../pulse-hover';

/**
 * Was the row HOVERED in the photograph, and was the noise floor measurable?
 * (genie#518)
 *
 * The E2E suite cannot stage either failure. A missed hover happens when the row
 * re-renders between `hover()` and `page.screenshot()`; a contaminated noise
 * sample happens when the ring changes between the two baseline frames. Neither
 * lands on demand. So the DECISIONS are here, tested against the numbers CI
 * actually produced, and the spec applies them.
 */

/** What a missed hover measured on macOS (#516). */
const MISSED = 97;

/**
 * `differingPixels(cU, eU)` per platform, measured on CI with the corrected
 * instrument (run 34078215365).
 *
 * ★ These replace an earlier table reading 564 / 7,808 / 7,838, which was used
 * here to argue that the platforms disagree by 14×. They do not: that spread
 * came from the contaminated capture sequence, and with it fixed all three sit
 * within 3%. The floors are small because the real signal is ~564 EVERYWHERE,
 * not because one platform is unusual.
 */
const SIGNAL = { macos: 564, ubuntu: 571, windows: 556 };

/** What the CORRECTED instrument measures for capture noise: nothing at all.
 *  Two back-to-back photographs of the same unhovered row are identical. */
const CLEAN_NOISE = 0;

/** The contaminated readings the FIRST instrument produced — kept because they
 *  are the evidence the plausibility gate exists for, and the shape it has to
 *  refuse. Both are Ubuntu's; Windows measured 7,662 against 7,838. */
const CONTAMINATED = { jitter: 7_625, sparkline: 7_808 };

describe('no floor may exceed the smallest real signal', () => {
    it('holds for every floor in the module', () => {
        // ★ The assertion that would have caught the 1,000 floor before CI did.
        // Any floor above ~556 fails a perfectly healthy row on every platform.
        const smallest = Math.min(...Object.values(SIGNAL));
        for (const floor of [HOVER_FILL_FLOOR, SPARKLINE_FLOOR]) {
            expect(floor).toBeLessThan(smallest);
        }
    });

    it('keeps the hover floor at the bound that already shipped', () => {
        // Never weaker than `> 100`, so this change cannot regress the guard.
        expect(HOVER_FILL_FLOOR).toBe(100);
        expect(hoverCaptureBound(0)).toBe(HOVER_FILL_FLOOR);
    });

    it('keeps the sparkline floor clear of the observed capture noise', () => {
        expect(SPARKLINE_FLOOR).toBeGreaterThan(MISSED * 2);
    });
});

describe('an implausible noise sample is rejected, not used', () => {
    it('refuses the contaminated reading the first instrument produced', () => {
        // 7,625 of "noise" against a 7,808 signal is not noise — the baseline
        // photographed a repaint. Using it put the bound at 76,250, ten times
        // the signal, and took Ubuntu and Windows red.
        expect(noiseWasMeasurable({ ...CONTAMINATED, hovered: 0 })).toBe(false);
    });

    it('accepts a believable one', () => {
        // Positive control: the same function does accept a real sample, so the
        // refusal above is the contamination and not a gate that never opens.
        expect(
            noiseWasMeasurable({ jitter: MISSED, hovered: 0, sparkline: SIGNAL.macos }),
        ).toBe(true);
        // And what the corrected instrument actually measures: nothing.
        expect(
            noiseWasMeasurable({ jitter: CLEAN_NOISE, hovered: 0, sparkline: SIGNAL.macos }),
        ).toBe(true);
    });

    it('still refuses a dead hover when the noise measures ZERO', () => {
        // The healthy case on CI is noise 0, which collapses the ratio to the
        // floor -- so the floor is what carries the guard in practice, and it
        // must still refuse a row that has stopped restyling.
        expect(hoverWasCaptured({ jitter: CLEAN_NOISE, hovered: CLEAN_NOISE })).toBe(false);
        expect(hoverWasCaptured({ jitter: CLEAN_NOISE, hovered: 50 })).toBe(false);
        // Positive control: the real hovered figure from CI passes comfortably.
        expect(hoverWasCaptured({ jitter: CLEAN_NOISE, hovered: 7_994 })).toBe(true);
    });

    it('scales across magnitudes instead of naming a constant', () => {
        // Expressed against the same-run signal, so it holds at 556 and at 7,838
        // alike -- which is what makes it survive the platform table above
        // turning out to have been wrong.
        for (const sparkline of [...Object.values(SIGNAL), 7_808, 7_838]) {
            const ok = sparkline / NOISE_SIGNAL_DIVISOR;
            expect(noiseWasMeasurable({ jitter: ok, hovered: 0, sparkline })).toBe(true);
            expect(noiseWasMeasurable({ jitter: ok + 1, hovered: 0, sparkline })).toBe(false);
        }
    });

    it('acts as the CEILING that stops a noisy sample tightening the bound', () => {
        // With noise held to a quarter of the signal, the derived bound can never
        // exceed three quarters of it — so the Ubuntu failure (bound 76,250 vs
        // signal 7,808) is unreachable by construction, not by a second number.
        for (const sparkline of [...Object.values(SIGNAL), 7_808, 7_838]) {
            const worst = sparkline / NOISE_SIGNAL_DIVISOR;
            expect(hoverCaptureBound(worst)).toBeLessThan(sparkline);
        }
    });
});

describe('a landed hover is separated from a missed one', () => {
    it('rejects the exact number CI produced for a missed hover', () => {
        expect(hoverWasCaptured({ jitter: MISSED, hovered: MISSED })).toBe(false);
    });

    it('accepts a hover worth even the SMALLEST platform’s row chrome', () => {
        // Sized to macOS's 564 rather than the comfortable 7,800: a guard that
        // only passes on the generous platforms is the bug already shipped once.
        expect(hoverWasCaptured({ jitter: 20, hovered: SIGNAL.macos })).toBe(true);
    });

    it('refuses a hovered frame that has collapsed to the noise floor', () => {
        // THE POINT. A row that stops painting its fill photographs the same
        // hovered as not, so `hovered` falls to `jitter` — caught at any
        // magnitude, on any platform, without knowing what the fill is worth.
        for (const jitter of [12, 97, 400, 1_900]) {
            expect(hoverWasCaptured({ jitter, hovered: jitter })).toBe(false);
        }
    });

    it('is not vacuous on a perfectly still frame', () => {
        expect(hoverWasCaptured({ jitter: 0, hovered: 50 })).toBe(false);
        expect(hoverWasCaptured({ jitter: 0, hovered: 5_000 })).toBe(true);
    });
});

describe('a run is usable only when BOTH hold', () => {
    it('rejects a contaminated baseline even when the hover looks enormous', () => {
        // The Ubuntu run, exactly: a hover figure that would sail past any fixed
        // bound, on top of a baseline that cannot be believed.
        expect(
            measurementIsUsable({ ...CONTAMINATED, hovered: 50_000 }),
        ).toBe(false);
    });

    it('accepts a run where the noise is small and the hover is real', () => {
        expect(
            measurementIsUsable({ jitter: 40, hovered: 4_000, sparkline: SIGNAL.ubuntu }),
        ).toBe(true);
    });
});

describe('the failure names which story the numbers tell', () => {
    const contaminated = { ...CONTAMINATED, hovered: 50_000 };
    const stale = { jitter: MISSED, hovered: MISSED, sparkline: SIGNAL.macos };

    it('calls a contaminated baseline a measurement failure, and says why', () => {
        const message = describeMeasurement(contaminated);
        expect(message).toMatch(/noise floor could not be measured/i);
        expect(message).toMatch(/repaint/i);
        expect(message).toContain('7625');
    });

    it('calls a stale hover a measurement failure, and names the OTHER case too', () => {
        const message = describeMeasurement(stale);
        expect(message).toMatch(/hover was not in the photograph/i);
        expect(message).toMatch(/measurement failure/i);
        // It must not hide the case where the row really is at fault.
        expect(message).toMatch(/stopped\s+painting/i);
    });

    it('always carries every number a reader needs', () => {
        for (const m of [contaminated, stale]) {
            expect(describeMeasurement(m)).toContain(String(m.sparkline));
            expect(describeMeasurement(m)).toContain(String(m.jitter));
        }
    });
});
