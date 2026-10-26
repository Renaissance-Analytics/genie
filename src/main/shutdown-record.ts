import type { AgentId } from '../core/identity.js';
import { midTurnAgents } from '../core/upgrade-drain.js';

/** What the shutdown record reads and writes: the roster, the host's session per agent, and the registry's two lists. */
export interface ShutdownRecordPorts {
    agents(): readonly { id: string }[];
    /** The agent's session in the host, or `null` when it has none: never started, or stopped. */
    probe(id: AgentId): { running: boolean; turnState: string; inTurn?: boolean | undefined } | null;
    markRunningAtQuit(ids: readonly AgentId[]): Promise<void>;
    markInterruptedAtQuit(ids: readonly AgentId[]): Promise<void>;
}

/**
 * EVERY SHUTDOWN — a quit or an upgrade — records who comes back and, separately, who was MID-TURN, before any session
 * ends. Ending the sessions is what cancels those turns; the next launch resumes the mid-turn agents and tells them to
 * continue (the owner, 2026-10-13: "ONLY active agents in the middle of turning, not any idle ones … on shutdown of
 * genie, not just an upgrade"), and starts every other one it recorded, unprompted.
 *
 * WHO COMES BACK (genie#1244): every agent that has a session in the host, which means Genie started it and nobody
 * stopped it. Its run may be idle, still starting, working, or FAILED. A person's Stop removes the session, so what the
 * person stopped stays stopped. This used to read `probe.running`, whether the provider PROCESS was alive at that
 * moment. On the owner's beta.45 → beta.47 upgrade that dropped 8 of 11 agents: beta.45's own boot had started them, the
 * start failed (Tynn preparation refused), nobody stopped them, and their processes were not alive at quit. So they
 * were not "running", fell off the list, and the next boot did not start them. Genie 1 kept the same intent
 * (`was_running`, set on start, cleared by the person's stop: main/terminal/ipc.ts:843 and :2019 at v0.7.0-beta.342;
 * main/agents/revival.ts:9-13), and a restore it could not start kept that intent for the next launch (ipc.ts:1193-1197).
 */
export function recordShutdown(ports: ShutdownRecordPorts): Promise<unknown> {
    // Read at once, synchronously, so it is taken before anything that follows can stop a session.
    const sessions = ports.agents().map((a) => ({ id: a.id as AgentId, probe: ports.probe(a.id as AgentId) }));
    const comeBack = sessions.filter((a) => a.probe !== null).map((a) => a.id);
    // MID-TURN = a turn in flight (`inTurn`), never `working`: a session only started reads `working` too (genie#1248).
    const midTurn = midTurnAgents(sessions.map((a) => ({ id: a.id, inTurn: a.probe?.inTurn ?? null }))) as AgentId[];
    return Promise.all([ports.markRunningAtQuit(comeBack), ports.markInterruptedAtQuit(midTurn)]);
}

/**
 * Restart-to-install's end of every session (updater.ts `DrainAgentsPort.stopAll`): the record is WRITTEN, on disk,
 * before the first session is stopped (genie#1244). It used to be fired and not awaited: the sessions stopped at once,
 * and the installer could take the process down before the write landed, leaving the list the last boot had emptied. A
 * record that cannot be written is reported and never holds the upgrade: the sessions end either way.
 */
export function recordThenStopAll(input: {
    markRecorded: () => void;
    record: () => Promise<unknown>;
    stopAll: (onLeft?: (left: number) => void) => Promise<void>;
    onRecordError?: (error: unknown) => void;
}): (onLeft?: (left: number) => void) => Promise<void> {
    return async (onLeft) => {
        // A later quit must not record again over this one (core/quit.ts `markRecorded`).
        input.markRecorded();
        try {
            await input.record();
        } catch (error) {
            input.onRecordError?.(error);
        }
        await input.stopAll(onLeft);
    };
}
