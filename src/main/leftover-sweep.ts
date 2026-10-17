import { execFileSync } from 'node:child_process';
import { leftoverProviders, type ProcessRow } from '../core/leftover-providers.js';

/**
 * THE BOOT SWEEP (Tynn #796, part 2): before Genie resumes any agent, end every provider still running one of its
 * agents' threads from a Genie that is gone — `core/leftover-providers.ts` decides which; this lists the machine's
 * processes and ends them. Runs once per boot, before the relaunch plan. A listing that cannot run sweeps nothing and
 * says so: nothing is never read as "kill everything".
 */

export interface SweepIo {
    /** Every process with its parent and command line. May throw: then nothing is swept. */
    list(): ProcessRow[];
    /** End exactly this pid (not its tree — the tree is already in the list). Already gone is fine. */
    end(pid: number): void;
}

function win32List(): ProcessRow[] {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const parsed = JSON.parse(out.trim() || '[]') as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((p) => {
        const r = p as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown };
        return typeof r.ProcessId === 'number' && typeof r.ParentProcessId === 'number' && typeof r.CommandLine === 'string'
            ? [{ pid: r.ProcessId, ppid: r.ParentProcessId, cmd: r.CommandLine }] : [];
    });
}

function posixList(): ProcessRow[] {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n').flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }] : [];
    });
}

export const systemSweepIo: SweepIo = {
    list: () => (process.platform === 'win32' ? win32List() : posixList()),
    end: (pid) => {
        try {
            if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 20_000, windowsHide: true });
            else process.kill(pid, 'SIGKILL');
        } catch {
            // already gone
        }
    },
};

export function sweepLeftoverProviders(
    sessions: readonly { readonly name: string; readonly threadId: string | null }[],
    io: SweepIo = systemSweepIo,
    log: (line: string) => void = (line) => console.log(line),
): Array<{ agent: string; pids: number[] }> {
    let rows: ProcessRow[];
    try {
        rows = io.list().filter((r) => r.pid !== process.pid);
    } catch (error) {
        log(`[genie] leftover providers: could not list processes, nothing swept (${error instanceof Error ? error.message : String(error)})`);
        return [];
    }
    const found = leftoverProviders(rows, sessions, process.pid);
    for (const { agent, pids } of found) {
        for (const pid of pids) io.end(pid);
        log(`[genie] leftover providers: ended ${pids.length} process(es) still running ${agent}'s session from a previous Genie (${pids.join(', ')})`);
    }
    return found;
}
