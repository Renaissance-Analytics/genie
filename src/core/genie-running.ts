import { join } from 'node:path';

/**
 * IS NORMAL GENIE RUNNING? Doctor mode asks before it starts an agent or changes data (the owner, 2026-10-13: read-only
 * while Genie runs — two Genies driving one agent's thread is how a conversation forks). Normal Genie writes its pid at
 * boot and removes the file at quit; a crash leaves the file behind, so the pid must also be alive — and never doctor's
 * own. A pid the OS has since handed to another process reads as running: the safe direction, read-only, said out loud.
 */
export function genieRunningFile(genieHome: string): string {
    return join(genieHome, 'runtime', 'genie.pid');
}

/** A running Genie, and the agents it says it has started — `null` from a build that does not say (treated as "any"). */
export type GenieRunning = { running: true; pid: number; agents: readonly string[] | null } | { running: false };

export function genieRunningFrom(raw: string | null, alive: (pid: number) => boolean, selfPid: number): GenieRunning {
    if (raw === null) return { running: false };
    let parsed: { pid?: unknown; agents?: unknown };
    try { parsed = JSON.parse(raw) as { pid?: unknown; agents?: unknown }; } catch { return { running: false }; }
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) return { running: false };
    const agents = Array.isArray(parsed.agents) && parsed.agents.every((a) => typeof a === 'string') ? (parsed.agents as string[]) : null;
    return alive(pid) ? { running: true, pid, agents } : { running: false };
}

/**
 * DOCTOR BESIDE A RUNNING GENIE (the owner, 2026-10-14: "doctor should be able to profile an agent even while we have
 * genie open. It should be able to load any Active workspace that has no started agents"). The rule, in one place:
 * awake, not genie's own, and nothing of the running Genie's started there. A Genie that does not say what it runs is
 * "may be anything" — refused, with the way out.
 */
export function doctorMayStart(input: {
    readonly genie: GenieRunning;
    readonly workspaceId: string;
    readonly osWorkspace: string;
    readonly asleep: boolean;
    /** The names of the running Genie's started agents in that workspace (the caller maps its ids to names). */
    readonly startedThere: readonly string[];
}): { ok: true; beside: boolean } | { ok: false; reason: string } {
    const g = input.genie;
    if (!g.running) return { ok: true, beside: false };
    if (g.agents === null) return { ok: false, reason: `Genie is running (pid ${g.pid}) and does not say which agents it has started — an older build. Restart Genie (or close it) and try again.` };
    if (input.workspaceId === input.osWorkspace) return { ok: false, reason: `Genie is running (pid ${g.pid}), and genie is its own agent there; doctor can run genie only with Genie closed.` };
    if (input.asleep) return { ok: false, reason: 'that workspace is hibernated; wake it in Genie first, or choose an awake one' };
    if (input.startedThere.length > 0) return { ok: false, reason: `Genie is running ${input.startedThere.join(', ')} in that workspace; doctor starts agents only where Genie has none started` };
    return { ok: true, beside: true };
}

/** Doctor's HOLD on a workspace while it runs an agent there beside a running Genie — which that Genie honours. */
export function doctorHoldFile(genieHome: string): string {
    return join(genieHome, 'runtime', 'doctor-hold.json');
}

export interface DoctorHold {
    readonly pid: number;
    readonly workspaceId: string;
    readonly agentId: string;
}

/** The live hold, or `null` (no file, garbage, or a doctor that is no longer running). */
export function doctorHoldFrom(raw: string | null, alive: (pid: number) => boolean): DoctorHold | null {
    if (raw === null) return null;
    let h: Partial<DoctorHold>;
    try { h = JSON.parse(raw) as Partial<DoctorHold>; } catch { return null; }
    if (typeof h.pid !== 'number' || typeof h.workspaceId !== 'string' || typeof h.agentId !== 'string') return null;
    return alive(h.pid) ? { pid: h.pid, workspaceId: h.workspaceId, agentId: h.agentId } : null;
}
