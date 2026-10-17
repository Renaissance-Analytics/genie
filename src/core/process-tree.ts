import { execFileSync } from 'node:child_process';

/**
 * STOP MEANS STOP — reaping what the driver's `kill` leaves behind, without reaping the machine.
 *
 * ## What was measured, including both mistakes
 *
 * The live check first reported **2 processes surviving `stop()`**, and the obvious reading was
 * damning: `ClaudeDriver.kill(signal)` signals the DIRECT child only. That looked exactly like
 * the previous build's defect, where a stop reported success and agents kept running.
 *
 * **It was wrong.** The surviving pids CHANGED IDENTITY between consecutive scans (56372, then
 * 960): one was a pre-existing descendant of the tsx wrapper, the other was the PowerShell the
 * scan itself spawns. The measuring instrument was contaminating the measurement.
 *
 * Measured truth, 2026-10-10: `driver.kill('SIGTERM')` terminated **all nine** provider
 * processes, and after a stop the descendant count returns exactly to its baseline. There is no
 * `prism-acp` defect here, and **the reaper below is defence in depth, not the mechanism.**
 *
 * ## The second mistake, which cost the owner a morning
 *
 * 06:14 local, same day. `npm run verify:resume` — which reaps for real — ran on the OWNER'S
 * DESKTOP. Six minutes later Genie's host service wrote its last log line and stayed down for
 * four and a half hours, taking the terminal the work was running in with it.
 *
 * Unproven: there is no kill record, the log simply stops. But the reap is the only thing in
 * that window that kills processes by enumeration.
 *
 * **The mechanism is a property of Windows, not a bug in the walk.** `win32Descendants` follows
 * WMI `ParentProcessId`. Windows recycles pids, so a process whose parent has exited keeps a
 * parent pointer that can now name a different, LIVE process — ours. The walk then returns
 * processes that were never ours, and `taskkill /T` took each one's whole tree.
 *
 * Re-walking does not help: the bad pointer is in the data, so the second walk agrees with the
 * first. **The enumeration cannot be made trustworthy, so the blast radius is bounded instead:**
 *
 *  1. **No `/T`.** Every genuine descendant is already in the set; expanding each kill into a
 *     tree only adds processes nobody verified.
 *  2. **A plausibility cap.** A session that started one provider asks to reap a handful of
 *     pids. If the walk claims dozens, the walk is wrong — somebody else's tree has been
 *     grafted onto ours by a recycled pointer. The reap is REFUSED and reported. That is
 *     exactly the case where killing is most destructive and least necessary.
 *  3. **Never on a failed walk.** A scan that cannot run reports nothing, and nothing must
 *     never be read as "kill everything".
 *  4. **No walk at all for an empty list** — the common case, since the driver normally reaps
 *     itself. A machine-wide PowerShell enumeration on every stop is its own cost.
 *
 * A defence that can kill the machine's agent host is worse than the leak it defends against.
 *
 * ## Why descendants of OUR pid, and not "any claude"
 *
 * This runs on a workstation with other agents live. A name-matching sweep would kill a
 * colleague's work, and that has happened on this machine. The right long-term fix is upstream —
 * a driver that owns a process should own its tree, or expose the pid so a caller can — and it
 * is reported to `prism-acp`.
 */

export interface ProcessTree {
    /** Pids of every live descendant of `pid`, at any depth. Empty when it cannot look. */
    descendantsOf(pid: number): readonly number[];
    /**
     * Terminate these pids, if they are still ours and the request is plausible.
     *
     * Never throws. The result says what happened, because `stop()` has to be able to tell
     * "reaped three" from "reaped nothing because the scan failed" — a stop that cannot
     * distinguish those is the promise the previous build broke.
     *
     * `oursBeforeKill` is the caller's own walk of this process's descendants, taken BEFORE the
     * provider's kill (`descendantsOf(process.pid)`). Given, it is what "still ours" is checked
     * against, and no walk happens here. It exists because a walk taken AFTER the kill cannot see
     * what the kill orphaned: on Windows prism-acp spawns its provider through `cmd.exe`
     * (`shell: true`) and kills only that `cmd.exe`, so the provider itself is left alive with a
     * dead parent — no longer reachable from this pid, so never "ours" to a later walk, and never
     * reaped (genie2 acceptance on the installed app, 2026-10-15: the agent's provider outlived
     * every quit). Absent, the walk is done here, now, as before.
     */
    killTree(pids: readonly number[], oursBeforeKill?: readonly number[]): ReapResult;
    /**
     * The live descendants of `pid` WITH each one's parent, from one walk: what a stop needs to find a session's tree as
     * it is NOW (Tynn #796). Empty when it cannot look. Absent on a tree that cannot report parents.
     */
    walk?(pid: number): readonly ProcessEdge[];
}

export interface ProcessEdge {
    readonly pid: number;
    readonly ppid: number;
}

/**
 * `roots` and everything under them in a walk — the tree a session owns AT THIS MOMENT, however its members came to be
 * there after the session started (a provider its shell launched later, a re-exec, a tool's child). Only pids the walk
 * names are added; the roots are kept as given.
 */
export function subtreeOf(edges: readonly ProcessEdge[], roots: readonly number[]): number[] {
    const children = new Map<number, number[]>();
    for (const e of edges) {
        const list = children.get(e.ppid);
        if (list) list.push(e.pid);
        else children.set(e.ppid, [e.pid]);
    }
    const out: number[] = [];
    const seen = new Set<number>();
    const queue = [...roots];
    while (queue.length > 0) {
        const pid = queue.shift()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        out.push(pid);
        for (const child of children.get(pid) ?? []) queue.push(child);
    }
    return out;
}

export interface ReapResult {
    killed: number;
    /** True when the reap was declined as unsafe. `reason` says why, for a surface to report. */
    refused: boolean;
    reason?: string;
}

/** The OS calls, injected so the safety rules above are testable without touching a machine. */
export interface ProcessTreeIo {
    /** Live descendants of `pid`, at any depth. May throw; callers treat a throw as "cannot look". */
    descendants(pid: number): number[];
    /** Terminate exactly this pid. Not its tree. Never throws for an already-dead pid. */
    killOne(pid: number): void;
    /** Live descendants of `pid` with each one's parent. May throw; callers treat a throw as "cannot look". */
    tree?(pid: number): Array<{ pid: number; ppid: number }>;
}

/**
 * How far beyond what the caller claims to own an enumeration may reach before it is disbelieved.
 *
 * Nine provider processes is the measured real case, so the floor has to clear it comfortably.
 * Sixty was what a recycled parent pointer could graft on. The number is a judgement, and the
 * test pins both sides of it: a normal nine-process tree reaps, a sixty-process claim refuses.
 */
const PLAUSIBLE_REAP = 24;

export function makeProcessTree(io: ProcessTreeIo, selfPid: () => number = () => process.pid): ProcessTree {
    const walkWithParents = io.tree;
    return {
        ...(walkWithParents ? {
            walk(pid: number): readonly ProcessEdge[] {
                try {
                    return walkWithParents(pid);
                } catch {
                    return [];
                }
            },
        } : {}),
        descendantsOf(pid) {
            try {
                return io.descendants(pid);
            } catch {
                // A scan that cannot run reports NOTHING, which the caller must not read as
                // "nothing is running" — `stop()` treats an empty reap as unverified rather
                // than as success.
                return [];
            }
        },

        killTree(pids, oursBeforeKill) {
            // Nothing to do, and no reason to walk the machine to find that out.
            if (pids.length === 0) return { killed: 0, refused: false };

            if (pids.length > PLAUSIBLE_REAP) {
                return {
                    killed: 0,
                    refused: true,
                    reason:
                        `Refusing to reap ${pids.length} processes for one session — more than ` +
                        `${PLAUSIBLE_REAP} means the parent-pid walk has picked up processes that ` +
                        `are not ours. The provider's own kill has already run.`,
                };
            }

            // The caller's pre-kill walk when it took one (see the interface); otherwise walk now. Either way the
            // same rules below apply to it: implausibly many is refused, and only a pid in it is killed.
            let live: readonly number[];
            try {
                live = oursBeforeKill ?? io.descendants(selfPid());
            } catch {
                return {
                    killed: 0,
                    refused: true,
                    reason: 'Refusing to reap: could not confirm which processes are ours.',
                };
            }

            if (live.length > PLAUSIBLE_REAP) {
                return {
                    killed: 0,
                    refused: true,
                    reason:
                        `Refusing to reap: the walk reports ${live.length} descendants, which is ` +
                        'more than this process can plausibly own.',
                };
            }

            const ours = new Set(live);
            let killed = 0;
            for (const pid of pids) {
                // Ours, by a walk taken no earlier than just before the provider's kill. A pid that has
                // exited and had its number reused would otherwise be somebody else's process — and on
                // this machine that is another agent's work.
                if (!ours.has(pid)) continue;

                io.killOne(pid);
                killed += 1;
            }
            return { killed, refused: false };
        },
    };
}

function win32Tree(pid: number): Array<{ pid: number; ppid: number }> {
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
        // descendant of the process being scanned. Counting it made a clean stop look like two
        // survivors and nearly produced a false bug report against prism-acp. Exclude this
        // process and anything under it.
        '$mine = @{}; $q2 = @($PID); while ($q2.Count -gt 0) { $h = $q2[0]; $q2 = @($q2 | Select-Object -Skip 1); $mine[$h] = $true; foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $h }) { if (-not $mine.ContainsKey($c.ProcessId)) { $q2 += $c.ProcessId } } }',
        '$parentOf = @{}; foreach ($p in $all) { $parentOf[$p.ProcessId] = $p.ParentProcessId };',
        '(@($seen.Keys | Where-Object { -not $mine.ContainsKey($_) } | ForEach-Object { "$($_):$($parentOf[$_])" })) -join ","',
    ].join(' ');

    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    return out.trim().split(',').filter((pair) => pair.length > 0).map((pair) => {
        const [pid, ppid] = pair.split(':').map((n) => Number.parseInt(n, 10));
        return { pid: pid!, ppid: ppid! };
    }).filter((e) => Number.isFinite(e.pid) && Number.isFinite(e.ppid));
}

function posixDescendants(pid: number): number[] {
    const out = execFileSync('bash', ['-lc', `pgrep -P ${pid} || true`], { encoding: 'utf8', timeout: 20_000 });
    const direct = out.trim().split('\n').map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
    // Same observer effect as win32: the shell doing the scan is a child of the process being
    // scanned, so it would count itself.
    return direct.filter((n) => n !== process.pid).flatMap((child) => [child, ...posixDescendants(child)]);
}

function posixTree(pid: number): Array<{ pid: number; ppid: number }> {
    const out = execFileSync('bash', ['-lc', `pgrep -P ${pid} || true`], { encoding: 'utf8', timeout: 20_000 });
    const direct = out.trim().split('\n').map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
    return direct.filter((n) => n !== process.pid).flatMap((child) => [{ pid: child, ppid: pid }, ...posixTree(child)]);
}

export const systemProcessTree: ProcessTree = makeProcessTree({
    descendants: (pid) => (process.platform === 'win32' ? win32Tree(pid).map((e) => e.pid) : posixDescendants(pid)),
    tree: (pid) => (process.platform === 'win32' ? win32Tree(pid) : posixTree(pid)),

    killOne: (pid) => {
        try {
            if (process.platform === 'win32') {
                /*
                 * NO `/T`, and that is the whole correction.
                 *
                 * `/T` takes the pid's entire tree, so one wrongly-enumerated pid becomes
                 * everything beneath it — which is how a reap of one provider can reach an
                 * unrelated service. Every genuine descendant is already in the verified set,
                 * so the tree flag adds only processes nobody checked.
                 */
                execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 20_000 });
            } else {
                process.kill(pid, 'SIGKILL');
            }
        } catch {
            // Already gone is the common case and is a success, not an error.
        }
    },
});
