/**
 * THE PAGE IS THIS RUN'S OWN LAUNCH (Tynn #1036 P6-1). In a gate shard the client-only update row talked to a page that
 * was not its Genie's (the full gate 1124-034522-b451dd): an earlier row's process still held the debugger port, the row's
 * Genie logged "Cannot start http server for devtools", and update-cdp.mjs read another app's page, whose bridge never came.
 * Each row has a port of its own now (test/ci-debug-ports-unique.test.ts), and a script that drives a Genie it launched
 * checks that the process listening on its port is that launch or one it started, before it reads anything there.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WIN = process.platform === 'win32';

/** Whether `pid` is `root` or descends from it through `parentOf`, within 64 steps (a table can hold a loop). */
export function descends(pid, root, parentOf) {
    let p = pid;
    for (let n = 0; n < 64 && Number.isInteger(p) && p > 0; n++) {
        if (p === root) return true;
        p = parentOf(p);
    }
    return false;
}

/** The pid listening on the port, or null: the operating system's word, never the page's. */
export function portOwner(port) {
    try {
        if (WIN) {
            const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8', timeout: 60_000, windowsHide: true }).trim();
            return /^\d+$/.test(out) ? Number(out) : null;
        }
        const m = /pid=(\d+)/.exec(execFileSync('ss', ['-ltnpH', `sport = :${Number(port)}`], { encoding: 'utf8', timeout: 15_000 }));
        return m ? Number(m[1]) : null;
    } catch {
        return null;
    }
}

/** Each process's parent: /proc on Linux, one read of the process table on Windows. */
function parents() {
    if (!WIN) return (pid) => { try { return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^[\s\S]*\) /, '').split(' ')[1]); } catch { return null; } };
    const table = new Map();
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)" }'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        for (const line of out.split(/\r?\n/)) { const [a, b] = line.split('|'); if (a && b) table.set(Number(a), Number(b)); }
    } catch { /* an unread table names no parent: the check below then refuses */ }
    return (pid) => table.get(pid) ?? null;
}

/** null when the page on `port` is served by `root` or a process it started; otherwise why not, in words. */
export function notOwnLaunch(port, root) {
    if (!Number.isInteger(root) || root <= 0) return `no launch pid to check the debugger port ${port} against`;
    const owner = portOwner(port);
    if (owner === null) return `the process listening on the debugger port ${port} could not be named`;
    return descends(owner, root, parents()) ? null : `the debugger port ${port} is held by pid ${owner}, which is not this run's launch (pid ${root}) or anything it started`;
}
