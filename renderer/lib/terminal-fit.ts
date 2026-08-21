/**
 * PURE. Should a terminal be re-fitted at this measured size? (genie#229)
 *
 * Off-workspace panels are kept mounted-hidden (`display: none`) so their ptys
 * survive a workspace switch. A hidden element measures **0×0**, and Chromium's
 * ResizeObserver fires for that transition — so the refit-on-resize safeguard ran
 * against a zero-size container and pushed a nonsense geometry through to the pty.
 *
 * The damage outlives the hiding, which is why the symptom looked so strange. A
 * TUI told it has almost no columns REFLOWS ITS OUTPUT to that width, and that
 * scrollback is already written by the time the panel comes back. Switching
 * workspaces returned a terminal whose history was wrapped at a width the window
 * never had: first characters clipped off the left, tails spilling into a sliver
 * down the right.
 *
 * So a zero measurement means "not visible", never "a very small terminal" — and
 * the same goes for a few pixels, which cannot hold one cell and would produce the
 * same nonsense less obviously.
 */

/** Below this, a container cannot hold a single character cell in either axis. */
const MIN_USABLE_PX = 8;

const usable = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= MIN_USABLE_PX;

export function shouldFit(
    rect: { width: number; height: number } | null | undefined,
): boolean {
    if (!rect) return false;
    return usable(rect.width) && usable(rect.height);
}
