import type { AgentRosterEntry } from './ams-grid';

/**
 * WHAT AN IMPORT BROUGHT, and whether the flow should stop for it (genie#459).
 *
 * The owner: *"If I import a project from tynn I need to be able to get an agent
 * I've already created going, I should not have to create a new one."*
 *
 * ## Which cause this is the fix for
 *
 * Not a duplicated workspace. A Tynn import is keyed by its PROJECT id
 * (`add-workspace.ts` — `id: projectId || plan.unlinkedId`), so the row it makes
 * is the row that project has and re-importing cannot fork the identity. What
 * the import cannot carry is `workspace_agents`, which lives only in the local
 * `genie.db`: the agents come down inside the clone as `.agents/<slug>/AGENT.md`
 * and land with no row on this machine. Measured, not read —
 * `main/workspace/__tests__/import-agents.test.ts`.
 *
 * So the agents were never missing. They were unannounced, and the only thing on
 * screen after an import was an empty grid whose one affordance is *create an
 * agent* — which is precisely the act that discards the identity, the saved
 * session, and everything the agent knew.
 *
 * ## Why this is a decision and not a render
 *
 * Two answers matter equally and only one of them draws anything. A roster with
 * nothing unregistered in it must close the modal exactly as before: a step that
 * lists nothing is worse than no step, and "the import offered a screen" is the
 * kind of claim that passes while offering an empty one. Both halves are
 * assertable here without a window.
 *
 * OFFERING IS THE WHOLE DESIGN. This decides what to SHOW; nothing here
 * registers anything. Silently adopting what a clone happens to contain would
 * make `git pull` a way to gain agents — and two of the three files this feature
 * exists to recover are hand-authored personas that ship as product deliverables
 * of the GApps they live in.
 */

export interface ImportedAgentsOffer {
    /**
     * Stop and show it. True when at least one agent file has no registration
     * here — INCLUDING one Genie refuses to adopt, because skipping that
     * silently is how a human concludes the import brought nothing.
     */
    offer: boolean;
    /** Files a human may adopt right now, in roster order. */
    adoptable: AgentRosterEntry[];
    /** Files that are here and cannot be adopted as they stand, with the reason. */
    refused: AgentRosterEntry[];
    /** Already registered — nothing to do, and the answer to "did mine come?" */
    registered: AgentRosterEntry[];
    /**
     * One line for the roster AS IT STANDS, which is why it is recomputed rather
     * than fixed when the step opens: adopting the last file leaves a screen
     * that must say every agent is registered, not that two are missing. Empty
     * only when the workspace has no agents at all, which nothing draws.
     *
     * It COUNTS, too — "some agents" reads the same at two and at none.
     */
    headline: string;
}

export function importedAgentsOffer(
    roster: readonly AgentRosterEntry[],
): ImportedAgentsOffer {
    const registered = roster.filter((entry) => entry.registered);
    // A registered agent whose file is gone is not an import finding: it is
    // already an agent, the grid shows it, and it can be started. Only the
    // unregistered half has anything left to do.
    const unregistered = roster.filter((entry) => !entry.registered && entry.onDisk);
    const adoptable = unregistered.filter((entry) => !entry.refusal);
    const refused = unregistered.filter((entry) => entry.refusal);

    return {
        offer: unregistered.length > 0,
        adoptable,
        refused,
        registered,
        headline: headlineFor(unregistered.length, registered.length),
    };
}

/**
 * Said the way the human would say it — these agents are the project's, not a
 * new thing being proposed — and true on both routes this is shown from: a fresh
 * import, and a project that was already here.
 */
function headlineFor(unregistered: number, registered: number): string {
    if (unregistered === 1) {
        return '1 agent already belongs to this project and is not registered on this machine.';
    }
    if (unregistered > 1) {
        return `${unregistered} agents already belong to this project and are not registered on this machine.`;
    }
    // Nothing left to adopt. Said out loud rather than left blank, because this
    // is the sentence somebody reads right after adopting the last one.
    return registered > 0 ? 'Every agent this project carries is registered here.' : '';
}
