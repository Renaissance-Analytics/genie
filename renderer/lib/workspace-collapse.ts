/**
 * Sidebar expand/collapse state for the workspace Chooser, persisted as the
 * `collapsed_workspaces` setting (a JSON `string[]` of the ids that ARE
 * collapsed — k/v values are text).
 *
 * genie#580: the sidebar opened with EVERY workspace expanded. The seed read the
 * setting as `JSON.parse(s?.collapsed_workspaces ?? '[]')`, so "nothing recorded"
 * and "the user deliberately expanded everything" were the SAME value — an empty
 * COLLAPSED set — and both rendered maximised. Every new remote connection has
 * nothing recorded, so every new remote window came up fully expanded. The owner
 * wants workspaces to start minimised.
 *
 * Inverting the default alone would trade one bug for another: with collapsed
 * polarity, an ABSENT setting must stay distinguishable from a recorded EMPTY
 * list, or a user who genuinely expanded everything is re-collapsed on every
 * launch. So "nothing recorded" is its own state — `null`, not an empty set —
 * which renders as collapse-all and is MATERIALISED into a real recorded list the
 * first time the user toggles a row.
 *
 * Kept as pure functions rather than inline in Chooser.tsx because the whole bug
 * was a polarity/default question, and a polarity is worth a test.
 *
 * NOTE (deliberately unchanged): this key is NOT scoped by `connKey`, unlike
 * `view_state_json` and `layout_json` — the local window and every host window
 * share one sidebar state. genie#580 raises per-connection scoping as a separate
 * question; nothing here forecloses it.
 */

/**
 * The recorded collapsed set, or `null` when NOTHING has been recorded —
 * including a malformed or wrong-shaped value, which is not a preference we can
 * honour. `'[]'` is a real preference (everything expanded) and parses to an
 * empty set, never to `null`.
 */
export function parseCollapsedWorkspaces(
    stored: string | null | undefined,
): Set<string> | null {
    if (!stored) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
}

/**
 * Whether a workspace row renders collapsed. `null` (nothing recorded) collapses
 * everything — the #580 default.
 */
export function isWorkspaceCollapsed(state: Set<string> | null, id: string): boolean {
    if (state === null) return true;
    return state.has(id);
}

/**
 * Toggle one row, returning the set to persist.
 *
 * From the unrecorded default every row is collapsed, so the first toggle EXPANDS
 * that row and materialises the implicit state into an explicit list — every
 * other currently-listed workspace, still collapsed. That write is what stops the
 * default from re-applying on the next launch and overriding the user.
 */
export function toggleWorkspaceCollapsed(
    state: Set<string> | null,
    id: string,
    allIds: readonly string[],
): Set<string> {
    if (state === null) {
        const next = new Set(allIds);
        next.delete(id);
        return next;
    }
    const next = new Set(state);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
}

/** Encode for the `collapsed_workspaces` setting. */
export function serializeCollapsedWorkspaces(state: Set<string>): string {
    return JSON.stringify([...state]);
}
