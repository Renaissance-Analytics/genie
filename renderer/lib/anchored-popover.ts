/**
 * Where a popover that is portaled out of the layout goes.
 *
 * Portaling to the overlay root is what stops an ancestor clipping a popover —
 * and it hands the component a bill it did not have before: the element is now
 * positioned against the VIEWPORT, so keeping it on screen is the caller's job.
 * Every popover in the renderer used to pay that bill itself, and each paid a
 * different part of it. The inventory at the time of genie#416 — TEN hand-written
 * placements across eleven render sites, because the split button positions two:
 *
 *   BOTH axes, the same eleven lines copied four times:
 *     AgentContextMenu, SpecContextMenu, ProjectContextMenu, FileTreeContextMenu
 *   HORIZONTAL only (ran off the BOTTOM):
 *     Chooser AgiHealth — the reported bug, under a comment claiming it clamped
 *     Chooser WorkspaceRuntimePill — inside the right edge by construction (`right`)
 *   VERTICAL only (ran off the SIDE):
 *     Chooser proc-log — and against a hard-coded 340px, not a measurement
 *     TerminalTypeSplitButton `row` variant — the one existing helper, half used
 *   NEITHER — opened at the cursor and left there:
 *     Chooser proc context menu, AgentPanel menu
 *
 * That spread is the argument for one helper rather than ten fixes: nobody was
 * careless. A rule kept as a per-component habit is a rule a new component can
 * miss one half of with nothing failing to compile. So it lives here once, and
 * `__tests__/popover-clamp-guard.test.ts` fails the next file that re-derives it.
 *
 * `Code/EditorWand` is the one deliberate non-caller: a pill centred on and
 * translated ABOVE a text selection, where "flip below" is the wrong question.
 */

/** A DOM rect, narrowed to what placement actually reads. */
export interface AnchorRect {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

/**
 * One axis: keep the span `[start, start + size]` inside `[0, viewport]`.
 *
 * The `max(margin, …)` is not belt-and-braces. When the popover is LARGER than
 * the viewport, `viewport - size - margin` is negative — pinning to it alone
 * puts the near edge (the title, the first menu item) off screen and leaves the
 * empty tail showing. Preferring the near edge keeps the readable part reachable
 * and hands the overflow to the element's own `overflow` instead.
 */
export function clampPopoverAxis({
    start,
    size,
    viewport,
    margin = 8,
}: {
    start: number;
    size: number;
    viewport: number;
    margin?: number;
}): number {
    return Math.max(margin, Math.min(start, viewport - size - margin));
}

/** Keep an anchored popover inside the viewport, preferring below the anchor. */
export function anchoredPopoverTop({
    anchorTop,
    anchorBottom,
    popoverHeight,
    viewportHeight,
    gap = 6,
    margin = 8,
}: {
    anchorTop: number;
    anchorBottom: number;
    popoverHeight: number;
    viewportHeight: number;
    gap?: number;
    margin?: number;
}): number {
    const below = anchorBottom + gap;
    if (below + popoverHeight + margin <= viewportHeight) return below;

    // When the bottom edge would clip the overlay, open upward. The final clamp
    // also keeps an overlay taller than the available space reachable.
    return clampPopoverAxis({
        start: anchorTop - gap - popoverHeight,
        size: popoverHeight,
        viewport: viewportHeight,
        margin,
    });
}

/**
 * A popover attached to an element — clamped on BOTH axes.
 *
 * Vertically it prefers below the anchor and flips above when there is no room,
 * which beats pinning to the bottom edge: a pinned popover can cover the very
 * control it describes. Horizontally it aligns to the anchor edge the caller
 * names (`start` = the popover's left to the anchor's left, `end` = its right to
 * the anchor's right) and then clamps, because alignment is a preference and the
 * viewport is not.
 */
export function anchoredPopoverPosition({
    anchor,
    popoverWidth,
    popoverHeight,
    viewportWidth,
    viewportHeight,
    align = 'start',
    gap = 6,
    margin = 8,
}: {
    anchor: AnchorRect;
    popoverWidth: number;
    popoverHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    align?: 'start' | 'end';
    gap?: number;
    margin?: number;
}): { top: number; left: number } {
    return {
        top: anchoredPopoverTop({
            anchorTop: anchor.top,
            anchorBottom: anchor.bottom,
            popoverHeight,
            viewportHeight,
            gap,
            margin,
        }),
        left: clampPopoverAxis({
            start: align === 'end' ? anchor.right - popoverWidth : anchor.left,
            size: popoverWidth,
            viewport: viewportWidth,
            margin,
        }),
    };
}

/**
 * A popover placed at a POINT — a right-click menu, or one opened beside a row.
 *
 * Both axes clamp; neither flips. A context menu that jumped above the cursor
 * would put a different item under the pointer than the one the user aimed at,
 * so it slides back into view rather than moving to the other side.
 */
export function clampPopoverToViewport({
    left,
    top,
    width,
    height,
    viewportWidth,
    viewportHeight,
    margin = 8,
}: {
    left: number;
    top: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
    margin?: number;
}): { top: number; left: number } {
    return {
        left: clampPopoverAxis({ start: left, size: width, viewport: viewportWidth, margin }),
        top: clampPopoverAxis({ start: top, size: height, viewport: viewportHeight, margin }),
    };
}
