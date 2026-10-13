/**
 * RESTORE AFTER AN UPGRADE (§7.6) — pure. Starts are spaced `RESTORE_GAP_MS` apart, in order. (The drain that asked
 * every live agent for a handoff before installing is gone: the owner, 2026-10-12 — an agent is a session that
 * resumes its own thread.)
 */

export const RESTORE_GAP_MS = 3_000;

/**
 * WHAT A RESUMED AGENT IS TOLD (the owner, 2026-10-13): its turn was cancelled by a Genie shutdown — a quit or an
 * upgrade — and it is to carry on. Sent ONLY to an agent that was mid-turn when Genie went down.
 */
export const RESUME_AFTER_RESTART =
    'Genie shut down while you were in the middle of a turn (Genie quit or was upgraded), so that turn was cancelled. ' +
    'Genie has started again and resumed this conversation. Continue the work you were doing, from where you left off. ' +
    'Check the state of anything you were changing before you carry on — the cancelled step may not have finished.';

/** The agents in the MIDDLE OF A TURN: `working`, and only that. Idle, failed, stopped and unknown are not. */
export function midTurnAgents(agents: readonly { id: string; turnState: string | null | undefined }[]): string[] {
    return agents.filter((a) => a.turnState === 'working').map((a) => a.id);
}

/**
 * THE RELAUNCH. The agents a shutdown interrupted mid-turn are started first and told to continue (`resume`) —
 * always, whatever `restore_agents_on_launch` says, because cancelling their turn was Genie's doing, not the person's.
 * Every other agent that was running is started only when `restoreAll` (that setting) is on, and is NOT prompted:
 * nothing was cut off. One start per agent, three seconds apart.
 */
export function relaunchPlan(input: { runningAtQuit: readonly string[]; interruptedAtQuit: readonly string[]; restoreAll: boolean }, gapMs: number = RESTORE_GAP_MS): Array<{ agentId: string; at: number; resume: boolean }> {
    const resumed = [...new Set(input.interruptedAtQuit)];
    const rest = input.restoreAll ? input.runningAtQuit.filter((id) => !resumed.includes(id)) : [];
    return [...resumed.map((agentId) => ({ agentId, resume: true })), ...rest.map((agentId) => ({ agentId, resume: false }))]
        .map((s, i) => ({ agentId: s.agentId, at: i * gapMs, resume: s.resume }));
}

/** Starts spaced at least three seconds apart, in the order given, the first at once. */
export function restoreSchedule(agentIds: readonly string[], gapMs: number = RESTORE_GAP_MS): Array<{ agentId: string; at: number }> {
    return agentIds.map((agentId, i) => ({ agentId, at: i * gapMs }));
}
