export function shouldShowWhatsNew(
    previouslySeen: string | null | undefined,
    currentVersion: string,
): boolean {
    return !!currentVersion && previouslySeen !== currentVersion;
}

/** How long after mount the automatic announcement may still open itself. */
export const WHATS_NEW_AUTO_BUDGET_MS = 1500;

/**
 * Decide whether the automatic What's New announcement may open.
 *
 * The modal is a full-screen backdrop, and the decision to show it needs two IPC
 * round-trips, so without a budget it can land long after the window became
 * interactive — on top of whatever the user is doing, swallowing the click they
 * were making. Past the budget we skip it for this session; the header menu
 * still opens it on demand, so nothing is lost but a deliberate click.
 */
export function autoOpenWhatsNew(input: {
    previous: string | null | undefined;
    current: string;
    elapsedMs: number;
    budgetMs?: number;
}): boolean {
    if (!shouldShowWhatsNew(input.previous, input.current)) return false;
    return input.elapsedMs <= (input.budgetMs ?? WHATS_NEW_AUTO_BUDGET_MS);
}
