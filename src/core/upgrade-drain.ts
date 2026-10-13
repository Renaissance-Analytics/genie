/**
 * RESTORE AFTER AN UPGRADE (§7.6) — pure. Starts are spaced `RESTORE_GAP_MS` apart, in order. (The drain that asked
 * every live agent for a handoff before installing is gone: the owner, 2026-10-12 — an agent is a session that
 * resumes its own thread.)
 */

export const RESTORE_GAP_MS = 3_000;

/** Starts spaced at least three seconds apart, in the order given, the first at once. */
export function restoreSchedule(agentIds: readonly string[], gapMs: number = RESTORE_GAP_MS): Array<{ agentId: string; at: number }> {
    return agentIds.map((agentId, i) => ({ agentId, at: i * gapMs }));
}
