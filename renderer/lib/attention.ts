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
