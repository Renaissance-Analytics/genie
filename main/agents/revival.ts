export interface RevivalSpec {
    id: string;
    type: string;
    workspace_id: string | null;
    meta?: { agent?: string; agent_id?: string; was_running?: boolean; user_stopped?: boolean } | null;
}

export interface RevivalOccasion {
    /**
     * A cold boot or an upgrade — nobody asked for anything.
     *
     * Distinct from host RECOVERY, where the detached pty host died mid-session while the
     * person was working: those agents were running a second ago and were never stopped, so
     * putting them back repairs a fault rather than deciding on someone's behalf. Recovery
     * must keep working whatever the preference says.
     */
    onLaunch: boolean;
    /** Has the user asked for agents to come back on launch? Default is NO. */
    optedIn: boolean;
}

/**
 * Which agents may be restored, and whether this is a moment to restore any.
 *
 * Two questions, deliberately separated. The filter used to answer only the first — "is this
 * agent restorable" — and `reviveRunningAgents()` ran unconditionally at boot, so the second
 * was never asked and the answer was always yes. A reboot therefore brought every agent back
 * working, which is what the owner hit: *"No more forced terminals on reboot?"*
 *
 * Omitting the occasion restores, so the host-recovery call site is unchanged by this. Making
 * "unspecified" mean launch would have silently disabled that repair — the opposite failure,
 * and a quieter one.
 */
export function agentsToRevive<T extends RevivalSpec>(
    specs: readonly T[],
    occasion?: RevivalOccasion,
): T[] {
    // Asked for nothing on a launch: restore nothing. Checked BEFORE the per-spec filter,
    // because the answer does not depend on any spec.
    if (occasion?.onLaunch && !occasion.optedIn) return [];
    return specs.filter(s => s.type === 'terminal' && !!s.workspace_id && !!s.meta?.agent
        && s.meta.was_running === true && !s.meta.user_stopped
        && s.meta.agent_id !== 'genie:workstation');
}
