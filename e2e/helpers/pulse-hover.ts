/**
 * Was the hover actually IN the photograph, and was the noise floor measurable?
 * (genie#518)
 *
 * `agent-pulse.spec.ts` proves the hover from the picture rather than from
 * computed style, because reading `:hover` back and trusting it across a
 * screenshot does not survive: the row re-renders about once a second as the
 * pulse ring shifts, and the hover goes stale somewhere around the capture. That
 * decision was right. What was wrong was the number it used.
 *
 * ## What 97 meant
 *
 * The guard asserted `differingPixels(unhovered, hovered) > 100`, with a comment
 * saying the opaque fill "repaints the whole row, so this is thousands of
 * pixels". On PR #516's macOS shard it returned **97**, and that reads as a
 * threshold three pixels too tight. It is not.
 *
 * Two populations land there, far apart: a hover that LANDED repaints the row,
 * and a hover that MISSED leaves the same row photographed twice, differing only
 * by capture noise — ~97. The bound was placed three pixels above the BOTTOM
 * population instead of between them. That makes it marginal against a stale
 * hover and, worse, VACUOUS against a real regression: if the row ever stopped
 * restyling on hover, noise alone would still clear 100 and the guard would pass
 * while reporting nothing. Its comment claimed thousands; it asserted a
 * hundredth of that.
 *
 * ## The ratio does the work, and the floor must not
 *
 * ★ If the row stops restyling, the hovered frame collapses towards the
 * unhovered one — towards the noise floor — so ANY bound expressed as a multiple
 * of that floor catches it, on any platform, without knowing what the fill is
 * worth there. An absolute number cannot: it has to be chosen, and the platforms
 * disagree about magnitude by 14×.
 *
 * Measured on CI, `differingPixels(cU, eU)` — the sparkline's own contribution:
 *
 *   | platform | signal    |
 *   |----------|-----------|
 *   | macOS    | **564**   |
 *   | Ubuntu   | 7,808     |
 *   | Windows  | 7,838     |
 *
 * A first version of this file set the floor to 1,000, reasoning from the
 * `test.fixme`'s recorded "~7,500". **That figure is Linux/Windows-specific**,
 * and 1,000 failed macOS on a perfectly healthy row — a number chosen to match
 * an assumption about the product, which is the very fault this file exists to
 * remove. Every floor here is now checked against the SMALLEST platform signal
 * by a test, so that mistake cannot be made twice quietly.
 *
 * ## The instrument had the same bug as the assertion
 *
 * The noise floor is measured, not assumed: two photographs of the same
 * unhovered row. The first version took the second one through `shotIn`, which
 * calls `freshPulses()` — so fresh samples changed the ring, the polyline
 * rescaled to a new max, and nearly every pixel moved. It came back at **7,625
 * on Ubuntu and 7,662 on Windows**: as large as the signal it was supposed to be
 * a fraction of. The bound derived from it landed at 76,250 against a real
 * signal of 7,808 — ten times the thing it was measuring.
 *
 * That is the same failure as the assertion it was built to fix: a number that
 * looked like evidence and was measuring something else. Two defences now:
 *
 *   1. the baseline is a back-to-back screenshot with nothing re-seeded; and
 *   2. **an implausible noise sample is REJECTED and retaken, never used** —
 *      see {@link noiseWasMeasurable}. A measurement that failed should be
 *      retaken and named, not quietly divided into a bound.
 */

/**
 * The smallest difference that can count as a hover at all.
 *
 * Deliberately the OLD bound, so this guard is never weaker than the one it
 * replaces, and deliberately doing none of the real work — the ratio does that.
 */
export const HOVER_FILL_FLOOR = 100;

/**
 * The smallest difference that can count as "the sparkline is visible".
 *
 * A fixed number, unlike the hover bound, because this comparison has no noise
 * baseline of its own that is independent of it — gating it on the same measured
 * jitter would be circular once {@link noiseWasMeasurable} already bounds the
 * jitter as a fraction of THIS signal.
 *
 * 300 rather than the 1,000 that suggests itself from the `test.fixme`: three
 * times the observed capture noise (~97), and comfortably under the **564**
 * macOS actually produces. 1,000 is above that and fails a healthy row — this is
 * the number that took all three platforms red once already.
 */
export const SPARKLINE_FLOOR = 300;

/**
 * How far above the frame's own capture noise a hovered frame must sit.
 *
 * The half that detects a row which has stopped restyling: such a row
 * photographs the same hovered as not, so its difference falls to the noise
 * floor and any multiple above 1 refuses it.
 */
export const JITTER_RATIO = 3;

/**
 * Noise may be at most this fraction of the real signal before the sample is
 * disbelieved — `jitter * NOISE_SIGNAL_DIVISOR <= sparkline`.
 *
 * Expressed against the signal measured in the SAME run rather than as a fixed
 * number, so it scales from macOS's 564 to Windows' 7,838 without anyone
 * choosing a per-platform constant. The contaminated 7,625 on Ubuntu fails this
 * against 7,808 and would have been retaken instead of used.
 *
 * It doubles as the CEILING on the derived bound: with `jitter` held to a
 * quarter of the signal, `jitter * JITTER_RATIO` can never exceed three quarters
 * of it, so a noisy sample cannot tighten the hover bound past the signal the
 * way it did on Ubuntu.
 */
export const NOISE_SIGNAL_DIVISOR = 4;

export interface HoverMeasurement {
    /** Differing pixels between two photographs of the same UNHOVERED row, taken
     *  back to back with nothing re-seeded — capture noise. */
    jitter: number;
    /** Differing pixels between the unhovered row and the hovered one. */
    hovered: number;
}

export interface RunMeasurement extends HoverMeasurement {
    /** Differing pixels between collapsed and expanded, unhovered — the
     *  sparkline's own contribution, and the scale everything else is judged
     *  against. */
    sparkline: number;
}

/** The bound `hovered` must clear, given what the frame's own noise measured. */
export function hoverCaptureBound(jitter: number): number {
    return Math.max(HOVER_FILL_FLOOR, Math.round(jitter * JITTER_RATIO));
}

/**
 * Is the noise sample believable at all?
 *
 * Capture noise is by definition a small fraction of a real visible change. A
 * "noise" reading as large as the signal is not noise — it is the instrument
 * having photographed a repaint, which is exactly what happened on Ubuntu and
 * Windows. Such a sample is rejected so it can be retaken, rather than divided
 * into a bound that then fails a healthy row.
 */
export function noiseWasMeasurable({ jitter, sparkline }: RunMeasurement): boolean {
    return jitter * NOISE_SIGNAL_DIVISOR <= sparkline;
}

/** Do these photographs prove the row was hovered when it was taken? */
export function hoverWasCaptured({ jitter, hovered }: HoverMeasurement): boolean {
    return hovered > hoverCaptureBound(jitter);
}

/** Everything the assertion depends on held, so the numbers can be trusted. */
export function measurementIsUsable(m: RunMeasurement): boolean {
    return noiseWasMeasurable(m) && hoverWasCaptured(m);
}

/**
 * Why the run is not proof — for a human reading a failed shard.
 *
 * Says which of the three stories the numbers tell, because they want different
 * responses and the first failure here was read as the wrong one.
 */
export function describeMeasurement(m: RunMeasurement): string {
    const { jitter, hovered, sparkline } = m;
    const numbers =
        `noise ${jitter}, hovered ${hovered}, sparkline ${sparkline}; ` +
        `hover bound ${hoverCaptureBound(jitter)}.`;

    if (!noiseWasMeasurable(m)) {
        return (
            `The NOISE FLOOR could not be measured: ${numbers} Two photographs of ` +
            `the same unhovered row differ by ${jitter}, which is not a small ` +
            `fraction of the ${sparkline} a real change costs — so the baseline ` +
            `caught a repaint rather than camera shake, and any bound derived ` +
            `from it would be nonsense. This is a MEASUREMENT failure; the run ` +
            `retakes it rather than using it.`
        );
    }
    return (
        `The hover was not in the photograph: ${numbers} ` +
        `A hovered figure close to the noise means the hover went stale between ` +
        `hover() and the screenshot — a MEASUREMENT failure, and not evidence ` +
        `about whether the row restyles. A figure well above the noise but still ` +
        `under the bound is the other story, and a real one: the row has stopped ` +
        `painting an opaque fill on hover.`
    );
}
