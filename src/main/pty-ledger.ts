import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * THE PTYS A HOST RUNS, ON DISK — so a pty never outlives its owner (batch L4, bug B; measured on omarchy-test, VM job 76).
 *
 * fancy-pty's helper does not end its shell when its control stream closes (fancy-pty 0.1.4, native/posix.rs: the control
 * thread returns on EOF; only a KILL frame ends the shell's group). So when a spawn host dies WITHOUT running its own
 * "kill every pty" — SIGKILLed with its host, as vm-smoke's `pkill` of Electron's binary does — the helper and its
 * `bash -l` live on under init, holding whatever they inherited. While the host lives, the relay already ends a dead
 * child's helpers by pid; when the host itself dies, that table dies with it.
 *
 * So the host writes the table here (`runtime/ptys.json`) as it changes, and the NEXT host reaps what a dead owner left
 * before it starts its own spawn hosts — the same "adopt or reap" a supervisor does for what it left. Only a pid that is
 * still the SAME process is ended: its start time (Linux /proc/<pid>/stat) must match the one recorded; a pid the OS has
 * since given to something else, an owner still alive, or a start time that cannot be read is never killed on a guess.
 */

export interface PtyEntry {
    readonly profile: string;
    readonly id: string;
    /** The pty's process as the engine reports it (fancy-pty's helper; its shell is the helper's child). */
    readonly pid: number;
    /** The process's start time, as /proc/<pid>/stat reports it; null where it cannot be read. */
    readonly start: string | null;
}

export interface PtyLedger {
    /** The host that runs these ptys. */
    readonly owner: number;
    readonly ptys: readonly PtyEntry[];
}

export function readPtyLedger(file: string): PtyLedger | null {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    const o = raw as { owner?: unknown; ptys?: unknown };
    if (typeof o?.owner !== 'number' || !Array.isArray(o.ptys)) return null;
    const ptys = o.ptys.flatMap((p: unknown): PtyEntry[] => {
        const e = p as Record<string, unknown>;
        if (typeof e?.['profile'] !== 'string' || typeof e['id'] !== 'string' || typeof e['pid'] !== 'number') return [];
        return [{ profile: e['profile'], id: e['id'], pid: e['pid'], start: typeof e['start'] === 'string' ? e['start'] : null }];
    });
    return { owner: o.owner, ptys };
}

/** Written whole and renamed into place: a reader never sees half a ledger. */
export function writePtyLedger(file: string, ledger: PtyLedger): void {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
    renameSync(tmp, file);
}

export interface ReapPorts {
    /** This host's pid: its own ledger is never reaped. */
    readonly self: number;
    alive(pid: number): boolean;
    /** The process's start time now; null where it cannot be read. */
    startOf(pid: number): string | null;
    childrenOf(pid: number): number[];
    /** SIGKILL `pid`, or its whole process group (`group`: a shell is its group's leader, so its jobs go with it). */
    kill(pid: number, group: boolean): void;
    log(line: string): void;
}

/** End the ptys a DEAD owner left that are still the same processes. Answers the pids it ended. */
export function reapLeftoverPtys(ledger: PtyLedger, ports: ReapPorts): number[] {
    if (ledger.owner === ports.self || ports.alive(ledger.owner)) return [];
    const reaped: number[] = [];
    for (const pty of ledger.ptys) {
        if (!(pty.pid > 0) || !ports.alive(pty.pid)) continue;
        const now = ports.startOf(pty.pid);
        if (pty.start === null || now === null || now !== pty.start) {
            ports.log(`pty ledger: pid ${pty.pid} (${pty.profile} ${pty.id}) not ended — ${pty.start === null || now === null ? 'its start time cannot be compared' : 'it is another process now'}`);
            continue;
        }
        // Its shell (and the shell's jobs) first, by process group, then the helper itself.
        for (const child of ports.childrenOf(pty.pid)) ports.kill(child, true);
        ports.kill(pty.pid, false);
        reaped.push(pty.pid);
    }
    if (reaped.length > 0) ports.log(`pty ledger: reaped ${reaped.length} pty(s) the dead host ${ledger.owner} left running: ${reaped.join(', ')}`);
    return reaped;
}

/** /proc/<pid>/stat's field 22 (starttime, in clock ticks since boot): unique per process for its life. Linux only. */
export function procStart(pid: number): string | null {
    if (process.platform !== 'linux' || !(pid > 0)) return null;
    try {
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ');
        return fields?.[19] ?? null;
    } catch {
        return null;
    }
}

function procChildren(pid: number): number[] {
    if (process.platform !== 'linux') return [];
    const out: number[] = [];
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            if (Number(readFileSync(`/proc/${name}/stat`, 'utf8').split(') ')[1]?.split(' ')[1]) === pid) out.push(Number(name));
        } catch { /* gone */ }
    }
    return out;
}

export function realReapPorts(log: (line: string) => void): ReapPorts {
    return {
        self: process.pid,
        alive: (pid) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
        startOf: procStart,
        childrenOf: procChildren,
        // Never pid ≤ 0: kill(0)/kill(-0) would address THIS process group.
        kill: (pid, group) => { if (!(pid > 0)) return; try { process.kill(group ? -pid : pid, 'SIGKILL'); } catch { /* gone */ } },
        log,
    };
}
