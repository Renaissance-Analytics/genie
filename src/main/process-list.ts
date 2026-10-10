import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import type { RunningProcess } from './upgrade.js';

/**
 * Every process the OS can name WITH ITS EXECUTABLE PATH — what §7.2's teardown scans.
 *
 * `process-tree.ts` walks parent→child by pid, which is the right shape for reaping a
 * provider's tree; the upgrade needs the other axis: "which processes, anywhere, run from
 * the install directory?" — the 31 `OpenConsole.exe` orphans were nobody's children by the
 * time the installer met them. So this lists by path, not by ancestry.
 *
 * On a failure to look it returns `[]`, and the CALLER must not read that as "none" —
 * `UpdateHost.install` reports what it killed, and a scan that could not run kills nothing
 * and says so by naming nothing. (That is the honest reading of an empty list; a thrown scan
 * mid-upgrade would be worse.)
 */
export function listProcesses(): readonly RunningProcess[] {
    try {
        return process.platform === 'win32' ? win32() : posix();
    } catch {
        return [];
    }
}

/**
 * Terminate ONE process — never a tree. The §7.2 teardown names each pid it stops, so each
 * is stopped by itself. `false` when the OS refused or the pid was already gone.
 */
export function killProcess(pid: number): boolean {
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 10_000 });
        } else {
            process.kill(pid, 'SIGKILL');
        }
        return true;
    } catch {
        return false;
    }
}

function win32(): RunningProcess[] {
    // ExecutablePath is null for processes we cannot query (SYSTEM's); those cannot be ours.
    const script =
        'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.ExecutablePath)" }';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
            const [pidText, parentText, ...rest] = line.split('|');
            const pid = Number.parseInt(pidText ?? '', 10);
            const parent = Number.parseInt(parentText ?? '', 10);
            // The path itself may contain '|' (it cannot on Windows, but join rather than assume).
            const executable = rest.join('|');
            return Number.isFinite(pid) && executable
                ? [{ pid, executable, parentPid: Number.isFinite(parent) ? parent : null }]
                : [];
        });
}

/** The 4th field of /proc/<pid>/stat, after the parenthesised comm (which may itself contain spaces). */
function parentOf(entry: string): number | null {
    try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number.parseInt(after[1] ?? '', 10);
        return Number.isFinite(ppid) ? ppid : null;
    } catch {
        return null;
    }
}

function posix(): RunningProcess[] {
    const found: RunningProcess[] = [];
    for (const entry of readdirSync('/proc')) {
        const pid = Number.parseInt(entry, 10);
        if (!Number.isFinite(pid)) continue;
        try {
            // A process that exited between readdir and readlink, or one we may not inspect,
            // is simply not listed — it cannot hold our files open in either case.
            found.push({ pid, executable: readlinkSync(`/proc/${entry}/exe`), parentPid: parentOf(entry) });
        } catch {
            // skip
        }
    }
    return found;
}
