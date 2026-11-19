import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { systemProcessTree, type ProcessInfo } from '../../src/core/process-tree.js';

/**
 * A TEST'S OWN CHILDREN, BY THEIR MARKERS (Tynn #919). Children that a test starts indirectly (a git hook's) write their
 * own pid as a marker, and the test checks on them and ends them afterwards.
 *
 * A PID ALONE IS NOT A PROCESS. git-read-limit's afterEach ended every marked pid that `process.kill(pid, 0)` called
 * alive; on Windows a dead node's pid goes to the next node quickly, and spawn-host-responsive's spawn host, in another
 * worker, was killed mid-call 7 ms after that test ended (queue item 1119-180839-a2ee1d: exit 1, no signal, no stderr),
 * so its Docker read answered 'absent'. A marked child is the SAME process only when the process holding its pid started
 * no later than its marker was written: the child writes the marker after it starts, and a process that took the pid
 * later started after the child ended, so after the marker. Start times come from the machine's own table
 * (core/process-tree: Windows CreationDate, ms; elsewhere `ps lstart`, whole seconds, which only ever reads earlier).
 */

export interface MarkedChildrenIo {
    /** Every process on the machine (pid, start time), or null when it cannot be read. */
    snapshot(): readonly ProcessInfo[] | null;
    /** End `pid`. Never throws for one already gone. */
    kill(pid: number): void;
}

export const systemMarkedChildrenIo: MarkedChildrenIo = {
    snapshot: () => systemProcessTree.snapshot(),
    kill: (pid) => { try { process.kill(pid); } catch { /* gone */ } },
};

const writtenAt = (marker: string): number | null => { try { return statSync(marker).mtimeMs; } catch { return null; } };

/** In one reading: whether `pid` is still the process that wrote `marker`. */
function sameChild(table: readonly ProcessInfo[], pid: number, marker: string): boolean {
    const p = table.find((q) => q.pid === pid);
    const at = writtenAt(marker);
    return p !== undefined && at !== null && p.started <= at;
}

/** Whether the child that wrote `marker` is still running: true, false, or null when the machine cannot be read. */
export function markedChildRunning(pid: number, marker: string, io: MarkedChildrenIo = systemMarkedChildrenIo): boolean | null {
    const table = io.snapshot();
    return table === null ? null : sameChild(table, pid, marker);
}

/** The children that marked themselves in `marks` (one file each, named by its pid) and still run, from one reading; null when it cannot be read. */
export function runningMarkedChildren(marks: string, io: MarkedChildrenIo = systemMarkedChildrenIo): number[] | null {
    if (!existsSync(marks)) return [];
    const table = io.snapshot();
    if (table === null) return null;
    return readdirSync(marks).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && sameChild(table, pid, join(marks, String(pid))));
}

/** End every marked child that is still the process that marked itself. The pids ended; none when the machine cannot be read. */
export function endMarkedChildren(marks: string, io: MarkedChildrenIo = systemMarkedChildrenIo): number[] {
    const running = runningMarkedChildren(marks, io) ?? [];
    for (const pid of running) io.kill(pid);
    return running;
}
