import type { AgentRecord } from '../core/identity.js';
import type { Finished } from './attention-store.js';

/**
 * "RESTART WITH THIS" (§4.5) — a finished agent is started again with its own handoff note as the
 * first prompt, so the next run picks up where the last one stopped.
 *
 * It is THE restart (genie#1238): `restart` is `restartAgent(…, 'graceful')`, the one action every Restart control
 * calls — it waits for the old run to end, starts from every state and delivers what the agent is owed. Then the note,
 * and only when the prompt was taken is the finish marked seen — a refused restart or an untaken prompt leaves the item
 * on the Deck with the reason said, so nothing is "done" that did not happen. The IPC handlers are thin calls into this.
 */

export interface RestartPorts {
    /** The one restart (main/agent-ops-host.ts `restartAgent(…, 'graceful')`). */
    restart(agentId: AgentRecord['id']): Promise<{ ok: true } | { ok: false; reason: string }>;
    prompt(agentId: AgentRecord['id'], text: string, by?: string | null): boolean;
}

export interface FinishedPort {
    finished(): readonly Finished[];
    markSeen(id: string): void;
}

export function handoffPrompt(handoff: string): string {
    return `You are restarting from your own handoff note. Pick up where it leaves off:\n\n${handoff}`;
}

export async function restartWithHandoff(ports: RestartPorts, attention: FinishedPort, record: AgentRecord, finishedId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const fin = attention.finished().find((f) => f.id === finishedId && f.agentId === record.id);
    if (!fin || fin.handoff === null) return { ok: false, reason: `no handoff ${finishedId} for ${record.name}` };

    const restarted = await ports.restart(record.id);
    if (!restarted.ok) return { ok: false, reason: restarted.reason };
    if (!ports.prompt(record.id, handoffPrompt(fin.handoff))) return { ok: false, reason: `${record.name} started but did not take the handoff prompt` };

    attention.markSeen(finishedId);
    return { ok: true };
}
