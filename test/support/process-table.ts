import { makeProcessTree, type ProcessInfo, type ProcessTreeIo } from '../../src/core/process-tree.js';

/**
 * A FAKE PROCESS TABLE with what the real snapshot reads (core/process-tree.ts): pid, parent, start time and image name.
 * Nothing is spawned and nothing on the machine is touched — `makeProcessTree` is the real rule set, this is the OS
 * under it. `killOne` records the kill and removes the process, unless it was marked unkillable.
 */
export function processTable(selfPid: number, initial: ReadonlyArray<{ pid: number; ppid: number; name?: string; started?: number }> = []) {
    let clock = 1_000;
    const rows = new Map<number, ProcessInfo>();
    const put = (pid: number, ppid: number, name = 'proc.exe', started?: number): ProcessInfo => {
        const row: ProcessInfo = { pid, ppid, started: started ?? (clock += 10), name };
        rows.set(pid, row);
        return row;
    };
    put(selfPid, 1, 'Genie.exe', 0);
    for (const r of initial) put(r.pid, r.ppid, r.name, r.started);
    const kills: number[] = [];
    const unkillable = new Set<number>();
    let snapshots = 0;
    let broken = false;
    const io: ProcessTreeIo = {
        snapshot() {
            snapshots += 1;
            if (broken) throw new Error('WMI unavailable');
            return [...rows.values()];
        },
        killOne(pid) {
            kills.push(pid);
            if (!unkillable.has(pid)) rows.delete(pid);
        },
    };
    return {
        tree: makeProcessTree(io),
        spawn: (pid: number, ppid: number, name?: string, started?: number) => put(pid, ppid, name, started),
        exit: (pid: number) => { rows.delete(pid); },
        alive: (pid: number) => rows.has(pid),
        row: (pid: number) => rows.get(pid),
        killsOf: (pid: number) => kills.filter((k) => k === pid).length,
        kills: () => [...kills],
        snapshots: () => snapshots,
        unkillable: (pid: number) => { unkillable.add(pid); },
        killable: (pid: number) => { unkillable.delete(pid); },
        breakSnapshots: () => { broken = true; },
    };
}
