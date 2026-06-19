/**
 * Pure orphan reconciliation for the detached pty-host.
 *
 * A live terminal's host id equals its spec id, so an id present in the host
 * but absent from the spec set is a pty that outlived its spec (its workspace
 * or spec was deleted, or a previous session crashed). A detached terminal that
 * is merely unattached still has a spec, so it is NEVER an orphan. Kept pure +
 * electron-free so the reconcile rule is unit-testable.
 */
export function computeOrphans(liveIds: string[], specIds: Iterable<string>): string[] {
    const specs = new Set(specIds);
    const orphans = liveIds.filter((id) => !specs.has(id));

    // SAFETY — refuse to reap in the two shapes that signal a problem rather
    // than a real orphan situation, because a false reap nukes LIVE terminals
    // (and their restore snapshots). Lingering a few ptys is far cheaper.
    //
    //   1. No specs at all, but terminals are live → the spec list almost
    //      certainly hasn't loaded yet (startup race) or the DB read failed.
    //   2. EVERY live terminal looks orphaned → the host's id namespace and the
    //      spec ids don't line up (the real cause of the "reopen wiped all my
    //      terminals" bug). You never legitimately have 100% orphans on boot.
    if (specs.size === 0) return [];
    if (liveIds.length > 0 && orphans.length === liveIds.length) return [];

    return orphans;
}
