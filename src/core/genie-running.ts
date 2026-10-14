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

export function genieRunningFrom(raw: string | null, alive: (pid: number) => boolean, selfPid: number): { running: true; pid: number } | { running: false } {
    if (raw === null) return { running: false };
    let pid: unknown;
    try { pid = (JSON.parse(raw) as { pid?: unknown }).pid; } catch { return { running: false }; }
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) return { running: false };
    return alive(pid) ? { running: true, pid } : { running: false };
}
