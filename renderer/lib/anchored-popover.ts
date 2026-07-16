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
    return Math.max(margin, Math.min(anchorTop - gap - popoverHeight, viewportHeight - margin - popoverHeight));
}
