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
 * There are two populations here, roughly two orders of magnitude apart:
 *
 *   - the hover LANDED  — the row is repainted, and the comment's "thousands"
 *   - the hover MISSED  — the two frames are the same row photographed twice,
 *                         differing only where the polyline shifted: ~97
 *
 * `> 100` was placed three pixels above the BOTTOM population instead of in the
 * gap between them. That makes it marginal against a missed hover and, worse,
 * VACUOUS against a real regression: if the row ever stopped restyling on hover,
 * polyline jitter alone would still clear 100 and the guard would pass.
 *
 * ## What replaces it
 *
 * The bound is derived from a measurement the suite takes on the same run: two
 * photographs of the SAME unhovered row. Their difference is the jitter floor —
 * platform, DPI, theme and timing all included, none of them guessed. A hovered
 * frame has to beat that by a wide ratio.
 *
 * A ratio alone would collapse to nothing on a perfectly still frame, so there
 * is also a floor. {@link HOVER_FILL_FLOOR} is an order of magnitude above the
 * observed missed-hover noise (97) and well below the "thousands" the row's own
 * repaint is documented to produce — the spec's `test.fixme` records the
 * sparkline alone at ~7,500 differing pixels. It sits in the gap rather than at
 * either edge, which is the whole correction.
 */

/**
 * The smallest difference that can count as a row-wide repaint.
 *
 * Not a tuned number: an order of magnitude above the measured missed-hover
 * noise, and an order of magnitude below the repaint it is looking for. If a
 * genuine hover ever measures under this, the row has stopped painting an opaque
 * fill and the guard SHOULD fail — that is the regression this bound exists to
 * catch, and the old `> 100` could not.
 */
export const HOVER_FILL_FLOOR = 1_000;

/** How far above the frame's own jitter a hovered frame has to sit. */
export const JITTER_RATIO = 10;

export interface HoverMeasurement {
    /** Differing pixels between two photographs of the same UNHOVERED row —
     *  the noise floor, measured rather than assumed. */
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
        `unhovered row already differ by ${jitter} (jitter, measured this run). ` +
        `A row-wide hover repaint has to clear ${bound}. ` +
        `A number close to the jitter means the hover went stale between hover() ` +
        `and the screenshot — a MEASUREMENT failure, not evidence about whether ` +
        `the row restyles. A number far above the jitter but still under the ` +
        `bound is the other story, and a real one: the row has stopped painting ` +
        `an opaque fill on hover.`
    );
}
