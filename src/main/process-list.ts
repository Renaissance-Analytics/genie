import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { promisify } from 'node:util';
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

/** `listProcesses` without holding the event loop (genie#1201: restart-to-install ran it on main, synchronously). */
export async function listProcessesAsync(): Promise<readonly RunningProcess[]> {
    try {
        if (process.platform !== 'win32') return posix();
        const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', WIN32_LISTING], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
        return parseWin32Listing(stdout);
    } catch {
        return [];
    }
}

/** `killProcess` without holding the event loop: one pid, never a tree. */
export async function killProcessAsync(pid: number): Promise<boolean> {
    try {
        if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(pid), '/F'], { timeout: 10_000, windowsHide: true });
        else process.kill(pid, 'SIGKILL');
        return true;
    } catch {
        return false;
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

// ExecutablePath is null for processes we cannot query (SYSTEM's); those cannot be ours.
// JSON, not a delimited line: a COMMAND LINE can contain any separator, and the boot reaper reads it (core/v1-reap).
const WIN32_LISTING =
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

function win32(): RunningProcess[] {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', WIN32_LISTING], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    return parseWin32Listing(out);
}

function parseWin32Listing(out: string): RunningProcess[] {
    const parsed = JSON.parse(out.trim() === '' ? '[]' : out) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId?: unknown; ParentProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown }>;
    return rows.flatMap((r) => {
        const pid = typeof r.ProcessId === 'number' ? r.ProcessId : NaN;
        const parent = typeof r.ParentProcessId === 'number' ? r.ParentProcessId : NaN;
        const executable = typeof r.ExecutablePath === 'string' ? r.ExecutablePath : '';
        return Number.isFinite(pid) && executable
            ? [{ pid, executable, parentPid: Number.isFinite(parent) ? parent : null, commandLine: typeof r.CommandLine === 'string' ? r.CommandLine : null }]
            : [];
    });
}

/** /proc/<pid>/cmdline, its NUL-separated arguments joined by spaces; `null` when it cannot be read. */
function commandLineOf(entry: string): string | null {
    try {
        const raw = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        return raw === '' ? null : raw.split('\0').filter((a) => a !== '').join(' ');
    } catch {
        return null;
    }
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
            found.push({ pid, executable: readlinkSync(`/proc/${entry}/exe`), parentPid: parentOf(entry), commandLine: commandLineOf(entry) });
        } catch {
            // skip
        }
    }
    return found;
}
