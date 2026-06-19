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

    return liveIds.filter((id) => !specs.has(id));
}
