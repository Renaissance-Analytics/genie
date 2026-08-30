/**
 * Workspace-level attention derivation, shared by the sidebar RAIL buttons and
 * the sidebar MENU (flyout) workspace rows so both glow consistently.
 */

/**
 * A workspace "needs attention" — and so glows in the rail AND the sidebar menu
 * row — iff ANY of its terminals is currently flagged for attention (an agent
 * called imDone / ForceTheQuestion in it). Driving the workspace ROW (not just
 * its terminal bar) means a COLLAPSED workspace still shows it's ready without
 * expanding it. Pure → unit-testable.
 */
export function workspaceNeedsAttention(
    specs: ReadonlyArray<{ id: string }>,
    attentionIds: ReadonlySet<string>,
): boolean {
    return specs.some((s) => attentionIds.has(s.id));
}

/**
 * Has any agent in this workspace just signalled readiness?
 *
 * The thumb is drawn on an agent's SQUARE in the grid. Collapse the workspace and
 * the grid is not rendered — so the agent thumbs up, the animation fires against
 * nothing, and the person waiting to see it sees nothing. Readiness that is only
 * visible if you already had the row open is not a signal.
 *
 * Same shape as {@link workspaceNeedsAttention}, deliberately: the row already
 * carries "a terminal in here wants you" for a collapsed workspace, and this is
 * "a terminal in here is ready" for the same reason. One rule, one place.
 */
export function workspaceHasThumb(
    specs: ReadonlyArray<{ id: string }>,
    thumbedTerminalIds: ReadonlySet<string>,
): boolean {
    return specs.some((s) => thumbedTerminalIds.has(s.id));
}
