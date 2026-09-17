import { isHibernated } from './workspace-hibernation';

/**
 * HIBERNATED WORKSPACES ARE OUT OF THE WAY BY DEFAULT (genie#705).
 *
 * The owner: "let's hide hibernated Workspaces by default but include a button
 * for showing hibernated workspaces." Hibernation is for the workspaces you are
 * NOT working in, and a rail that still lists five of them has not got them out
 * of the way.
 *
 * Hiding one costs nothing that hiding the System Workspace does not already
 * cost, and for the same reason it is safe: a hibernated workspace is STOPPED by
 * definition — no terminal, process, schedule, site or service of it is running —
 * so nothing invisible here is doing work. That is exactly why this filter is
 * about hibernated workspaces and no others.
 *
 * PURE, so the flyout tree, the 56px icon rail and the reveal control all decide
 * it the same way rather than each filtering for itself.
 */

interface Hibernatable {
    hibernated_at?: number | null;
}

/** The rows the rail shows: hibernated ones drop out unless they are revealed. */
export function withoutHibernated<T extends Hibernatable>(
    workspaces: readonly T[],
    revealed: boolean,
): T[] {
    if (revealed) return [...workspaces];
    // Order is never touched — revealing must not reshuffle the rail, and a
    // workspace that wakes up returns to the place it had.
    return workspaces.filter((w) => !isHibernated(w));
}

/** How many the control is hiding, so the button can say so instead of being a
 *  toggle with no stated effect. */
export function hiddenHibernatedCount(workspaces: readonly Hibernatable[]): number {
    return workspaces.filter((w) => isHibernated(w)).length;
}

/**
 * The workspace that should be ACTIVE once hidden rows are taken out.
 *
 * Hiding the active workspace would stand the window on a row the rail denies
 * exists, showing a floor for a workspace you cannot see or click. The System
 * Workspace toggle already falls back this way when it hides the row you were
 * on; this is the same rule for the same reason.
 *
 * Returns null when nothing is visible to fall back to — a machine whose owner
 * hibernated everything is a real state, and it must not resolve to a hidden row.
 */
export function activeAfterHiding<T extends Hibernatable & { id: string }>(
    activeId: string | null,
    workspaces: readonly T[],
    revealed: boolean,
): string | null {
    const visible = withoutHibernated(workspaces, revealed);
    if (activeId && visible.some((w) => w.id === activeId)) return activeId;
    return visible[0]?.id ?? null;
}
