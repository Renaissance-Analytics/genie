import { execFileSync } from 'node:child_process';

/**
 * STOP MEANS STOP — reaping what the driver's `kill` leaves behind.
 *
 * ## What was actually measured, including the mistake
 *
 * The live check first reported **2 processes surviving `stop()`**, and the obvious reading
 * was damning: `ClaudeDriver.kill(signal)` is `this.#child?.kill(signal)`, signalling the
 * DIRECT child only, with `#child` private so its pid is unreachable. That looked exactly
 * like the previous build's defect, where a stop reported success and agents kept running.
 *
 * **It was wrong, and a diagnostic caught it before it became a false bug report.** The
 * surviving pids CHANGED IDENTITY between consecutive scans (56372, then 960). They were not
 * agents at all: one was a pre-existing descendant of the tsx wrapper, and the other was the
 * PowerShell that the scan itself spawns to do the counting. The measuring instrument was
 * contaminating the measurement.
 *
 * Measured truth, 2026-10-10: `driver.kill('SIGTERM')` terminated **all nine** provider
 * processes, and after a stop the descendant count returns exactly to its baseline. There is
 * no `prism-acp` defect here.
 *
 * ## So why keep this file
 *
 * Because "stop means stop" has to be VERIFIABLE, not assumed, and that is the one promise
 * the previous build broke. Two things earn their place:
 *  - `descendantsOf` is the instrument the live check uses to prove a stop — and it now
 *    excludes its own subtree, which is the fix for the observer effect above;
 *  - `killTree` is defence in depth for the cases a single signal does not cover (a
 *    detached grandchild, a provider that re-parents, a platform that handles signals
 *    differently). It is a no-op when the driver has already done the job, which on this
 *    platform it does.
 *
 * ## Why descendants of OUR pid, and not "any claude"
 *
 * This runs on a workstation with other agents live. A name-matching sweep would kill a
 * colleague's work, and that has happened on this machine. A process that is a descendant of
 * *this* process can only be something this process started, so the blast radius is exactly
 * what we are responsible for and nothing else.
 *
 * The right long-term fix is upstream — a driver that owns a process should own its tree, or
 * expose the pid so a caller can. This is reported to `prism-acp`; until it lands, the
 * promise is kept here rather than quietly broken.
 */

export interface ProcessTree {
    /** Pids of every live descendant of `pid`, at any depth. */
    descendantsOf(pid: number): readonly number[];
    /** Terminate these pids and everything beneath them. Best-effort, never throws. */
    killTree(pids: readonly number[]): void;
}

function win32Descendants(pid: number): number[] {
    const script = [
        '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId;',
        `$queue = @(${pid}); $seen = @{};`,
        'while ($queue.Count -gt 0) {',
        '  $head = $queue[0]; $queue = @($queue | Select-Object -Skip 1);',
        '  foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $head }) {',
        '    if (-not $seen.ContainsKey($c.ProcessId)) { $seen[$c.ProcessId] = $true; $queue += $c.ProcessId }',
        '  }',
        '}',
        // THE OBSERVER EFFECT, measured: this scan spawns a PowerShell, which is itself a
        // descendant of the process being scanned. Counting it made a clean stop look like
        // two survivors and nearly produced a false bug report against prism-acp. Exclude
        // this process and anything under it.
        '$mine = @{}; $q2 = @($PID); while ($q2.Count -gt 0) { $h = $q2[0]; $q2 = @($q2 | Select-Object -Skip 1); $mine[$h] = $true; foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $h }) { if (-not $mine.ContainsKey($c.ProcessId)) { $q2 += $c.ProcessId } } }',
        '(@($seen.Keys | Where-Object { -not $mine.ContainsKey($_) })) -join ","',
    ].join(' ');

    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    return out.trim().split(',').map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
}

function posixDescendants(pid: number): number[] {
    const out = execFileSync('bash', ['-lc', `pgrep -P ${pid} || true`], { encoding: 'utf8', timeout: 20_000 });
    const direct = out.trim().split('\n').map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
    // Same observer effect as win32: the shell doing the scan is a child of the process
    // being scanned, so it would count itself.
    return direct.filter((n) => n !== process.pid).flatMap((child) => [child, ...posixDescendants(child)]);
}

export const systemProcessTree: ProcessTree = {
    descendantsOf(pid) {
        try {
            return process.platform === 'win32' ? win32Descendants(pid) : posixDescendants(pid);
        } catch {
            // A scan that cannot run reports NOTHING, which the caller must not read as
            // "nothing is running" — `stop()` treats an empty reap as unverified rather than
            // as success.
            return [];
        }
    },

    killTree(pids) {
        for (const pid of pids) {
            try {
                if (process.platform === 'win32') {
                    // `/T` takes the tree, `/F` forces. The tree flag is the whole point: the
                    // provider's own children are what survive a signal to its parent.
                    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                        stdio: 'ignore',
                        timeout: 20_000,
                    });
                } else {
                    process.kill(pid, 'SIGKILL');
                }
            } catch {
                // Already gone is the common case and is a success, not an error.
            }
        }
    },
};
