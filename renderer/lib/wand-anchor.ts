/**
 * Geometry helpers for the Code editor's selection-anchored wand pill
 * (`renderer/components/Code/EditorWand.tsx`).
 *
 * Both live here rather than in the component because they are the two places
 * the wand can feed itself a render: `sameAnchor` decides whether a measured
 * selection is worth a `setState` at all, and `clampWandX` runs inside a layout
 * effect — i.e. DURING the commit, where a correction that never reaches a
 * fixed point is exactly React's "Maximum update depth exceeded" (#185).
 * Pure functions, so both are testable without a DOM.
 */

export interface WandAnchor {
    x: number;
    y: number;
}

/**
 * Sub-pixel moves are invisible for a floating pill, and re-rendering for them
 * is pure churn: every `selectionchange` would allocate a fresh anchor object,
 * React could never bail out, and both of the wand's effects would tear down
 * and re-subscribe. Half a pixel is the threshold between "the selection moved"
 * and "layout jitter".
 */
const EPSILON = 0.5;

/** True when two anchors describe the same point (or are both absent). */
export function sameAnchor(a: WandAnchor | null, b: WandAnchor | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

/**
 * Keep the pill inside the viewport horizontally. Returns the corrected `x`, or
 * `null` when nothing needs to move.
 *
 * `left`/`right` are the RENDERED pill's viewport-space edges (it is centred on
 * `x` by a CSS translate, so the caller can't derive them). The correction is
 * applied to `x`, which moves both edges by the same delta — so one pass always
 * lands the offending edge exactly on its margin and the second pass returns
 * `null`.
 *
 * A pill too wide to satisfy both margins is the one case where that guarantee
 * breaks: honouring the left edge violates the right and vice versa, so a naive
 * clamp ping-pongs forever. Such a pill is pinned to the LEFT margin and left
 * there — a fixed point, deliberately, because the alternative is an unbounded
 * update loop.
 */
export function clampWandX({
    x,
    left,
    right,
    viewportWidth,
    pad = 6,
}: {
    x: number;
    left: number;
    right: number;
    viewportWidth: number;
    pad?: number;
}): number | null {
    const min = pad;
    const max = viewportWidth - pad;
    const width = right - left;

    if (width >= max - min) return left === min ? null : x + (min - left);
    if (left < min) return x + (min - left);
    if (right > max) return x - (right - max);
    return null;
}
