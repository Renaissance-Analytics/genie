import type { AgentRecord } from '../core/identity.js';
import type { StopVerdict } from '../core/session.js';
import type { Finished } from './attention-store.js';

/**
 * "RESTART WITH THIS" (§4.5) — a finished agent is started again with its own handoff note as the
 * first prompt, so the next run picks up where the last one stopped.
 *
 * Stop first: this is a RESTART, not a reattach. Then start, then prompt, and only when the prompt
 * was taken mark the finish seen — a refused start or an untaken prompt leaves the item on the Deck
 * with the reason said, so nothing is "done" that did not happen. The main process's IPC handler is
 * a thin call into this; the ports are the session host's own methods.
 */

export interface RestartPorts {
    stop(agentId: AgentRecord['id']): boolean;
    /** How the last stop ended, once it has (`SessionHost.ended`): the start waits for it, or a Claude in its grace refuses it. */
    ended(agentId: AgentRecord['id']): Promise<StopVerdict | null>;
    start(record: AgentRecord, cwd: string): { ok: true } | { ok: false; reason: string };
    prompt(agentId: AgentRecord['id'], text: string, by?: string | null): boolean;
}

export interface FinishedPort {
    finished(): readonly Finished[];
    markSeen(id: string): void;
}

export function handoffPrompt(handoff: string): string {
    return `You are restarting from your own handoff note. Pick up where it leaves off:\n\n${handoff}`;
}

export async function restartWithHandoff(ports: RestartPorts, attention: FinishedPort, record: AgentRecord, cwd: string, finishedId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const fin = attention.finished().find((f) => f.id === finishedId && f.agentId === record.id);
    if (!fin || fin.handoff === null) return { ok: false, reason: `no handoff ${finishedId} for ${record.name}` };

    ports.stop(record.id);
    // The old run ends first (its grace, its kill, a verified reading): started in the same tick, a Claude was refused
    // "still stopping" and the note never reached it.
    const verdict = await ports.ended(record.id);
    if (verdict && !verdict.verified && verdict.survivors.length > 0) {
        return { ok: false, reason: `${record.name}'s previous run did not end, so it was not started again: ${verdict.reason}` };
    }
    const started = ports.start(record, cwd);
    if (!started.ok) return started;
    if (!ports.prompt(record.id, handoffPrompt(fin.handoff))) return { ok: false, reason: `${record.name} started but did not take the handoff prompt` };

    attention.markSeen(finishedId);
    return { ok: true };
}
