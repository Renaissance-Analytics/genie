/**
 * Sidecars — a driver's second agent, under a different TUI.
 *
 * A sidecar keeps its own conversation warm alongside the agent that registered
 * it, and is named `<driver>-slave`. That convention was already in use by hand
 * before it was expressed in code: `codex:tynn-slave`, `codex:fancy-slave`,
 * `codex:moic-slave` and others, each paired with a `claude` agent of the same
 * base name.
 *
 * It matters for STOPPING. `deleteRegisteredAgent` killed only the agent's own
 * terminals — its `terminal_spec_id` plus every `agent_runtimes` binding. A
 * sidecar is a separate `workspace_agents` row, so unmounting or deleting
 * `moic` left `moic-slave` running against work whose driver no longer exists.
 *
 * Pure and name-only, so the rule is testable without a database and reads the
 * same everywhere it is applied.
 */

const SUFFIX = '-slave';

/** The sidecar name for a driver, or null when the driver IS one — a sidecar
 *  has no sidecar, and `x-slave-slave` is not a thing. */
export function sidecarNameFor(driverName: string): string | null {
    if (isSidecarName(driverName)) return null;
    return `${driverName}${SUFFIX}`;
}

/** Whether a name denotes a sidecar. Requires something BEFORE the suffix, so
 *  an agent legitimately called `slave` is not read as one. */
export function isSidecarName(name: string): boolean {
    return name.length > SUFFIX.length && name.endsWith(SUFFIX);
}

/**
 * The sidecars belonging to `driverName`, out of a workspace roster.
 *
 * Matched on the WHOLE name, never a prefix: `tynnbuilder` is its own agent and
 * must not be stopped as `tynn`'s sidecar, and `moic-slave` must not be stopped
 * when `tynn` is.
 */
export function sidecarNamesOf<T extends { name: string }>(
    driverName: string,
    roster: readonly T[],
): T[] {
    const wanted = sidecarNameFor(driverName);
    if (!wanted) return [];
    return roster.filter((a) => a.name === wanted);
}
