/**
 * Was the hover actually IN the photograph? (genie#518)
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
 * There are two populations, far apart:
 *
 *   - the hover LANDED  — the row is repainted
 *   - the hover MISSED  — the two frames are the same row photographed twice,
 *                         differing only by capture noise: ~97
 *
 * `> 100` was placed three pixels above the BOTTOM population instead of in the
 * gap. That makes it marginal against a stale hover and, worse, VACUOUS against
 * a real regression: if the row ever stopped restyling on hover, noise alone
 * would still clear 100 and the guard would pass.
 *
 * ## Why the bound is a RATIO, and why the floor is small
 *
 * ★ THE RATIO IS WHAT REMOVES THE VACUITY. THE FLOOR IS NOT.
 *
 * If the row stops restyling on hover, the hovered frame collapses towards the
 * unhovered one — towards the noise floor — so ANY bound expressed as a multiple
 * of that floor catches it. An absolute number cannot: it has to be chosen, and
 * choosing it needs a magnitude nobody has measured on every platform.
 *
 * A first version of this file set that floor to 1,000, reasoning from the
 * `test.fixme`'s recorded "~7,500 differing pixels". **That figure is
 * platform-specific and the assumption was wrong.** Measured on CI:
 *
 *   | platform | sparkline (`cU` vs `eU`) |
 *   |----------|--------------------------|
 *   | macOS    | **564**                  |
 *   | Ubuntu   | 7,808                    |
 *   | Windows  | 7,838                    |
 *
 * macOS renders the comparison region fourteen times smaller than the number the
 * comment records, so a 1,000 floor failed there on a perfectly healthy row.
 * That is the same fault this file exists to fix, committed one level up: a
 * number chosen to match an assumption about the product.
 *
 * So the floor is {@link HOVER_FILL_FLOOR} = 100 — exactly the old bound, never
 * weaker than what shipped — and all of the new strength comes from
 * {@link JITTER_RATIO}, which needs no magnitude at all.
 *
 * ## The noise floor has to be measured WITHOUT re-seeding the ring
 *
 * The first version took its baseline from two shots that each re-seeded the
 * pulse (`freshPulses()`), and measured 7,625 on Ubuntu and 7,662 on Windows —
 * as large as the sparkline itself. Of course: fresh samples change the ring,
 * the polyline rescales to a new max, and nearly every pixel moves. That is the
 * CHART changing, not the camera shaking.
 *
 * The baseline is now two screenshots taken back to back in the same state, with
 * nothing re-seeded in between. What they differ by is capture noise and nothing
 * else, which is the only thing a hovered frame should be judged against.
 */

/**
 * The smallest difference that can count as a hover at all.
 *
 * Deliberately the OLD bound, so this guard is never weaker than the one it
 * replaces, and deliberately doing none of the real work — see the header. A
 * larger floor has to be justified by a magnitude measured on every platform,
 * and the platforms disagree by 14×.
 */
export const HOVER_FILL_FLOOR = 100;

/**
 * How far above the frame's own capture noise a hovered frame must sit.
 *
 * This is the half that can detect a row which has stopped restyling: such a row
 * photographs the same hovered as not, so its difference falls to the noise floor
 * and any multiple above 1 refuses it. Three rather than ten because the
 * baseline is now genuine capture noise — small, and worth leaving room around.
 */
export const JITTER_RATIO = 3;

export interface HoverMeasurement {
    /** Differing pixels between two photographs of the same UNHOVERED row, taken
     *  back to back with nothing re-seeded — capture noise, measured rather than
     *  assumed, on this platform and at this DPI. */
    jitter: number;
    /** Differing pixels between the unhovered row and the hovered one. */
    hovered: number;
}

/** The bound `hovered` must clear, given what the frame's own noise measured. */
export function hoverCaptureBound(jitter: number): number {
    return Math.max(HOVER_FILL_FLOOR, Math.round(jitter * JITTER_RATIO));
}

/** Do these photographs prove the row was hovered when it was taken? */
export function hoverWasCaptured({ jitter, hovered }: HoverMeasurement): boolean {
    return hovered > hoverCaptureBound(jitter);
}

/**
 * Why the photographs are not proof — for a human reading a failed shard.
 *
 * Deliberately says MEASUREMENT rather than blaming the row: a hover that never
 * reached the picture says nothing about whether the row restyles on hover, and
 * the previous failure was read as a product regression for exactly that reason.
 */
export function describeHoverCapture({ jitter, hovered }: HoverMeasurement): string {
    const bound = hoverCaptureBound(jitter);
    return (
        `The hover was not in the photograph: the hovered frame differs from the ` +
        `unhovered one by ${hovered} pixels, and two photographs of the SAME ` +
        `unhovered row differ by ${jitter} (capture noise, measured this run). ` +
        `A hover has to clear ${bound}. ` +
        `A number close to the noise means the hover went stale between hover() ` +
        `and the screenshot — a MEASUREMENT failure, not evidence about whether ` +
        `the row restyles. A number well above the noise but still under the ` +
        `bound is the other story, and a real one: the row has stopped painting ` +
        `an opaque fill on hover.`
    );
}
