import type { AgentId } from '../core/identity.js';
import { midTurnAgents } from '../core/upgrade-drain.js';

/** What the shutdown record reads and writes: the roster, the host's session per agent, and the registry's two lists. */
export interface ShutdownRecordPorts {
    agents(): readonly { id: string }[];
    probe(id: AgentId): { running: boolean; turnState: string } | null;
    markRunningAtQuit(ids: readonly AgentId[]): Promise<void>;
    markInterruptedAtQuit(ids: readonly AgentId[]): Promise<void>;
}

/**
 * EVERY SHUTDOWN — a quit or an upgrade — records who was running and, separately, who was MID-TURN, before any session
 * ends. Ending the sessions is what cancels those turns; the next launch resumes exactly those agents and tells them to
 * continue (the owner, 2026-10-13: "ONLY active agents in the middle of turning, not any idle ones … on shutdown of
 * genie, not just an upgrade").
 */
export function recordShutdown(ports: ShutdownRecordPorts): Promise<unknown> {
    const live = ports.agents().map((a) => ({ id: a.id as AgentId, probe: ports.probe(a.id as AgentId) }));
    const running = live.filter((a) => a.probe?.running === true).map((a) => a.id);
    const midTurn = midTurnAgents(live.map((a) => ({ id: a.id, turnState: a.probe?.turnState ?? null }))) as AgentId[];
    return Promise.all([ports.markRunningAtQuit(running), ports.markInterruptedAtQuit(midTurn)]);
}

/**
 * Restart-to-install's end of every session (updater.ts `DrainAgentsPort.stopAll`): the running set is recorded, then
 * the sessions end.
 */
export function recordThenStopAll(input: {
    markRecorded: () => void;
    record: () => Promise<unknown>;
    stopAll: (onLeft?: (left: number) => void) => Promise<void>;
}): (onLeft?: (left: number) => void) => Promise<void> {
    return (onLeft) => {
        // Record who was running and who was MID-TURN BEFORE the sessions end (§7.6; the owner, 2026-10-13).
        input.markRecorded();
        void input.record();
        return input.stopAll(onLeft);
    };
}
