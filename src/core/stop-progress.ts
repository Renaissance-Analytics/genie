import { join } from 'node:path';

/**
 * THE HOST'S STOP, SAID AS IT GOES (Tynn #1079; #1058 L5). "Shut down everything" used to give genie-host 5 s and then end
 * it (main/agent-engine.ts), while a host with 122 kept processes was still stopping them: it never reached its clean-exit
 * marker, so its next boot read a crash. Now the launcher stops the host (native/launcher/src/host.rs `stop_host_with`)
 * and waits for as long as the host keeps moving: the host writes `<runtime>/host-stopping.json` at every step of its
 * shutdown and as its processes go, and the launcher ends it only when that file stands still.
 *
 * Progress is the step and what is left in it changing, never a clock: a host stuck in one step with the same count left
 * is a stall however often it writes.
 */
export const STOP_PROGRESS_FILE = 'host-stopping.json';

export interface StopProgressRecord {
    readonly pid: number;
    /** The shutdown's step: agents, terminals, services, processes, hosting, exit. */
    readonly step: string;
    /** What is still to stop in that step (sessions, processes, ...); 0 when the step has nothing to count. */
    readonly remaining: number;
    readonly at: number;
}

export interface StopProgressPorts {
    readonly pid: number;
    readonly now: () => number;
    /** Writes the file whole (a temporary file renamed over it). */
    readonly write: (file: string, text: string) => void;
}

export interface StopProgress {
    step(step: string, remaining?: number): void;
}

export function stopProgress(_runtimeDir: string, _ports: StopProgressPorts): StopProgress {
    return { step: () => undefined };
}

/** The file's path in a runtime folder. */
export function stopProgressFile(runtimeDir: string): string {
    return join(runtimeDir, STOP_PROGRESS_FILE);
}
