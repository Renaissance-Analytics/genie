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
 *
 * ## The converse is NOT true (genie#491)
 *
 * That rule holds in one direction only, and the code used to assume both: a
 * non-zero measurement does not mean the panel is on screen.
 *
 * On CI a pty sitting on 103 columns came back on 67. Nothing crashed and nothing
 * measured zero — an off-workspace panel was measured while the Floor was still
 * reflowing, and 67 columns' worth of container is a perfectly usable number. So
 * the size test passed it through and the fit was pushed to the pty, which is the
 * damage described above arriving through the one door the guard left open. The
 * window is short; under CI contention it is wide enough to land in, which is why
 * this read as a flaky test for as long as it did.
 *
 * Hence `onScreen`. The grid already knows which panels are visible — every entry
 * `buildPanelList` produces carries it, and `TerminalGrid` already reasons with it
 * — so visibility is passed in as a FACT instead of being inferred from a
 * measurement that cannot carry it.
 */

/** Below this, a container cannot hold a single character cell in either axis. */
const MIN_USABLE_PX = 8;

const usable = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= MIN_USABLE_PX;

/**
 * @param onScreen whether the panel is on the ACTIVE workspace. `false` refuses
 * outright, whatever it measures. Omitted means "the caller cannot tell", which
 * falls back to the measurement alone — the behaviour that shipped — so a caller
 * that has not been given the signal is never silently stopped from fitting.
 */
export function shouldFit(
    rect: { width: number; height: number } | null | undefined,
    onScreen?: boolean,
): boolean {
    if (onScreen === false) return false;
    if (!rect) return false;
    return usable(rect.width) && usable(rect.height);
}
