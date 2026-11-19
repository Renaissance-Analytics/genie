import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemProcessTree, type ProcessInfo } from '../../src/core/process-tree.js';

/**
 * A TEST'S OWN CHILDREN, BY THEIR MARKERS (Tynn #919). Children that a test starts indirectly (a git hook's) write their
 * own pid as a marker, and the test checks on them and ends them afterwards.
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

/** Whether the child that wrote `marker` is still running: true, false, or null when the machine cannot be read. */
export function markedChildRunning(pid: number, _marker: string, io: MarkedChildrenIo = systemMarkedChildrenIo): boolean | null {
    const table = io.snapshot();
    if (!table) return false;
    return table.some((p) => p.pid === pid);
}

/** End every child that marked itself in `marks` (one file per child, named by its pid). The pids ended. */
export function endMarkedChildren(marks: string, io: MarkedChildrenIo = systemMarkedChildrenIo): number[] {
    if (!existsSync(marks)) return [];
    const ended: number[] = [];
    for (const name of readdirSync(marks)) {
        const pid = Number(name);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        if (markedChildRunning(pid, join(marks, name), io) === true) { io.kill(pid); ended.push(pid); }
    }
    return ended;
}
