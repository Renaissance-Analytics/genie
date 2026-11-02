import type { AgentRecord } from '../core/identity.js';

/**
 * START ON FIRST MESSAGE (the owner, 2026-11-01, q_04ce323c: "opening an agent must NOT start it"). Opening an agent
 * shows it; its session starts when something sends it work — the person's first message (`genie:prompt`, a remote
 * window's `prompt`), a flow's prompt, mail that wakes it (main's `wakeAgent`, under its own manual/automated rules), or
 * Start. This is the one rule those senders share:
 *
 * - a session already here is used AS IT IS: never restarted, never a second copy — an agent the person left running
 *   stays exactly as it was, and one whose run ended on its own (Broken) is left to be read, with the chat's Restart;
 * - an agent with none is started in its folder, unless its workspace is asleep or the agent cap is reached, which is
 *   said by name and starts nothing.
 *
 * A message sent to a session still coming up waits for its `ready` in the session's own queue and goes the moment it is
 * up; the chat shows it waiting for the start (core/chat-view.ts `queuedForStart`).
 *
 * The agent engine may answer LATER: in the host split the window's engine is a replica of genie-host's
 * (main/session-engine-client.ts), whose `start` is the host's answer, a Promise. So the rule is asynchronous, and the
 * answer awaited is the host's own: a refusal there is the refusal here.
 */
type StartAnswer = { ok: true } | { ok: false; reason: string };

export interface StartOnDemandPorts {
    probe(agentId: AgentRecord['id']): { readonly running: boolean } | null;
    start(record: AgentRecord, cwd: string): StartAnswer | Promise<StartAnswer>;
    cwdFor(record: AgentRecord): string;
    /** An asleep workspace or the agent cap (workspace-ops-host `startRefusal`); `null` = may start. */
    startRefusal(record: AgentRecord): string | null;
}

export type StartForWork = { ok: true; started: boolean } | { ok: false; reason: string };

export async function startForWork(ports: StartOnDemandPorts, record: AgentRecord): Promise<StartForWork> {
    if (ports.probe(record.id) !== null) return { ok: true, started: false };
    const refused = ports.startRefusal(record);
    if (refused !== null) return { ok: false, reason: refused };
    const started = await ports.start(record, ports.cwdFor(record));
    return started.ok ? { ok: true, started: true } : started;
}
