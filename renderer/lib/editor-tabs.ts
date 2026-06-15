/**
 * Pure tab-list reducers for the Code editor's multi-file model.
 *
 * Kept out of the React component so the open/close/activate ordering rules
 * (dedup on open, neighbour-activation on close) are unit-testable without a
 * DOM. `CodePanel` owns the per-file content/dirty map separately; these
 * helpers only move the open-tab list + the active tab around.
 */

export interface TabState {
    /** Open tabs in display order (workspace-relative paths). */
    open: string[];
    /** The active (front) tab, or null when nothing is open. */
    active: string | null;
}

/** Open (or focus) a path. Existing tabs aren't duplicated; the path becomes active. */
export function openTab(open: string[], path: string): TabState {
    return {
        open: open.includes(path) ? open : [...open, path],
        active: path,
    };
}

/**
 * Close a path. When the closed tab was active, the neighbour at the same
 * index takes over (or the new last tab if it was the rightmost); closing the
 * last tab leaves `active: null`. Closing a non-active tab keeps the active one.
 */
export function closeTab(
    open: string[],
    active: string | null,
    path: string,
): TabState {
    const idx = open.indexOf(path);
    const next = open.filter((p) => p !== path);
    if (active !== path) return { open: next, active };
    return { open: next, active: next[Math.min(idx, next.length - 1)] ?? null };
}

/**
 * Reconcile a persisted tab set against the files that actually loaded
 * (some may have been deleted since last session). Drops missing tabs and
 * falls back the active tab to the first survivor.
 */
export function reconcileTabs(
    seedOpen: string[],
    loaded: string[],
    seedActive: string | undefined,
): TabState {
    const open = seedOpen.filter((p) => loaded.includes(p));
    if (!open.length) return { open: [], active: null };
    const active = seedActive && open.includes(seedActive) ? seedActive : open[0];
    return { open, active };
}
