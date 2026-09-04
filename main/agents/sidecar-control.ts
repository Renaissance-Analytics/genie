import { isSidecarName, sidecarNameFor } from './sidecar';

/**
 * Which rows are THIS agent's sidecars, so a human can start, stop and restart
 * them from the agent manager (Tynn #709).
 *
 * The design of record says to prefer `workspace_agents.parent_agent_id` over
 * the `<driver>-slave` name convention, because "a rule that keys on a name is
 * one rename away from leaking". That is right, and the column is used here —
 * but it cannot be the SOLE discriminator today, and the reason is worth
 * writing down where the next person will find it.
 *
 * `registerAgentInWorkspace` sets `parent_agent_id: workspaceDefaultAgent(ws.id)?.id`
 * for EVERY agent it registers. The column currently means "the workspace's
 * designated default agent", not "the agent that spawned me". So in any
 * workspace with a Workspace Agent — every workspace seeded since genie#324 —
 * the whole roster already carries an FK pointing at the TWA. An FK-only rule
 * would make the TWA the parent of every agent in the workspace, and a human
 * pressing "Stop the sidecar" would stop a colleague's agent instead.
 *
 * So the rule has two halves:
 *
 *   - the row must BE a sidecar at all — the `-slave` suffix, which is still how
 *     sidecars are created;
 *   - and this driver must own it — by FK, or failing that by name.
 *
 * The FK half is what finds a RENAMED sidecar, which is precisely the leak the
 * design was worried about. The suffix half is what stops the FK's present
 * overload from swallowing the roster. Re-pointing the column at real sidecar
 * ownership is #708's migration; this resolver keeps working unchanged after it,
 * and gets strictly better — every sidecar gains an accurate FK and the name
 * stops being load-bearing.
 *
 * PURE, like `sidecar.ts` next to it, so the rule is testable without a
 * database and reads the same everywhere it is applied.
 */

/** The minimal shape the resolver needs — a roster row. */
export interface SidecarSubject {
    id: string;
    name: string;
    parent_agent_id: string | null;
}

/** The sidecars `driver` owns, out of a workspace roster. */
export function sidecarsOf<T extends SidecarSubject>(
    driver: { id: string; name: string },
    roster: readonly T[],
): T[] {
    // A sidecar has no sidecar, and `x-slave-slave` is not a thing.
    const byName = sidecarNameFor(driver.name);
    if (!byName) return [];
    return roster.filter(
        (row) =>
            row.id !== driver.id &&
            isSidecarName(row.name) &&
            (row.parent_agent_id === driver.id || row.name === byName),
    );
}

export type SidecarAction = 'start' | 'stop' | 'restart';

/**
 * Which controls the manager may offer.
 *
 * A dormant sidecar must not be stoppable (the button would error) and a running
 * one must not be startable (it would spawn a second copy against the same
 * work). With no sidecar there is nothing at all — a control that acts on
 * nothing is worse than an absent one, because it looks like it did something.
 */
export function sidecarActions(state: { exists: boolean; running: boolean }): SidecarAction[] {
    if (!state.exists) return [];
    return state.running ? ['stop', 'restart'] : ['start'];
}
