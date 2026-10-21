import { describeProcesses, findIn, subtreeOf, unionOf, type ProcessInfo } from './process-tree.js';

/**
 * THE SPAWN LEDGER — what Genie started, written down, so a Genie that died cannot leave it running unrecorded
 * (hosting plan 1.5; lifecycle review F6/F7, 2026-10-20).
 *
 * The boot sweep used to know one thing: `claude --print … --resume <a thread an agent still has>`. It never caught the
 * orphan of a FRESH restart (the agent no longer has that thread), a first-run session (no `--resume` yet), a wedged
 * one, or any Codex agent. Now every spawn is recorded with each process's pid, START TIME and image name, and at boot,
 * before anything starts, the tree of every record from a previous boot whose pid AND start time AND name all still
 * match is ended. **Never a process Genie did not record**, and never one whose pid was merely reused (the start time
 * differs): that keeps "never kill what Genie did not start" while covering every kind.
 */

export interface LedgerRecord {
    /** What spawned it: `agent` today; the pty helpers, Caddy and php-cgi join (hosting plan 2.1). */
    readonly kind: string;
    /** The agent id (or pty id, site id) it belongs to. */
    readonly ownerId: string;
    /** Which run of the owner, so a restart's new record never replaces the old one's. */
    readonly run: number;
    /** The Genie boot that wrote it: a record of THIS boot is never swept. */
    readonly bootId: string;
    readonly processes: readonly ProcessInfo[];
    /** Epoch ms when it was recorded. */
    readonly at: number;
}

/**
 * The processes to end at boot: for each record of a PREVIOUS boot, every recorded process still running as the same
 * process (pid, start time, name) and everything under it now. One entry per record with something to end.
 */
export function leftoversToEnd(
    records: readonly LedgerRecord[],
    table: readonly ProcessInfo[],
    bootId: string,
): Array<{ record: LedgerRecord; processes: ProcessInfo[] }> {
    const out: Array<{ record: LedgerRecord; processes: ProcessInfo[] }> = [];
    for (const record of records) {
        if (record.bootId === bootId) continue;
        const alive = record.processes.filter((p) => findIn(table, p) !== undefined);
        if (alive.length === 0) continue;
        out.push({ record, processes: unionOf(alive, subtreeOf(table, alive)) });
    }
    return out;
}

/** The lifecycle-log line for one swept record. */
export function sweepLine(record: LedgerRecord, ended: readonly ProcessInfo[]): string {
    return `sweep kind=${record.kind} owner=${record.ownerId} run=${record.run} boot=${record.bootId} ended=${describeProcesses(ended)}`;
}
