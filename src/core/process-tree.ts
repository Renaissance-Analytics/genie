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
 * Measured truth, 2026-10-10 (Linux): `driver.kill('SIGTERM')` terminated **all nine** provider
 * processes. On Windows it does not: prism-acp spawns the provider through `cmd.exe` and its kill
 * reaches that `cmd.exe` only — `claude.exe` and everything under it live on (VM acceptance
 * 2026-10-15; hosting review lifecycle F2, 2026-10-20). There the reap below is the mechanism.
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
 * **The mechanism is a property of Windows, not a bug in the walk.** WMI `ParentProcessId` is a
 * number, and Windows recycles pids, so a process whose parent has exited keeps a parent pointer
 * that can now name a different, LIVE process — ours. A walk by parent pointer alone returns
 * processes that were never ours, and `taskkill /T` took each one's whole tree.
 *
 * **So a process is known by its pid AND its start time, and the blast radius is bounded:**
 *
 *  1. **No `/T`.** Every genuine descendant is already in the set; expanding each kill into a
 *     tree only adds processes nobody verified.
 *  2. **No graft.** A process that started BEFORE its claimed parent is not its child, whatever
 *     its parent pointer says — that is exactly what a recycled pointer looks like. And a process
 *     is killed only when the reading taken just before shows the SAME process: pid, start time
 *     and image name.
 *  3. **A plausibility cap — on what ONE SESSION asks to reap.** A session that started one
 *     provider asks to reap a handful of processes; if its own subtree claims dozens, the reap is
 *     REFUSED and reported. The cap is never measured against Genie's whole tree. It was, and on
 *     the owner's desktop (165 descendants of Genie) every reap was refused, silently: every Stop
 *     and Restart left `claude.exe` alive, and a restart ran two Claudes on one conversation
 *     (hosting review lifecycle F1, 2026-10-20).
 *  4. **Never on a failed read.** A scan that cannot run is `null`, and nothing must never be
 *     read as "kill everything" — nor as "nothing is running".
 *  5. **No read at all for an empty list.**
 *
 * A defence that can kill the machine's agent host is worse than the leak it defends against.
 *
 * ## Why descendants of OUR spawn, and not "any claude"
 *
 * This runs on a workstation with other agents live. A name-matching sweep would kill a
 * colleague's work, and that has happened on this machine. The right long-term fix is upstream —
 * a driver that owns a process should own its tree (a Job Object / process group), or expose the
 * pid so a caller can — and it is asked of `prism-acp` (hosting plan P1).
 */

export interface ProcessTree {
    /**
     * One reading of every process on the machine: pid, parent, start time and image name. `null` when it could not
     * look — never an empty machine, which a caller would read as "nothing is running".
     */
    snapshot(): readonly ProcessInfo[] | null;
    /**
     * End exactly these processes, each only if the SAME process (pid, start time, name) is in `now` — a reading the
     * caller took just before. Never its tree: the caller already chose the tree. Never throws.
     *
     * The result says what happened, because a stop has to tell "reaped three" from "refused" — a stop that cannot
     * distinguish those is the promise the previous build broke.
     */
    killTree(targets: readonly ProcessInfo[], now: readonly ProcessInfo[], limit?: number): ReapResult;
}

/** One process as the snapshot reads it. `started` is epoch ms (Windows: CreationDate; Linux/macOS: `ps lstart`). */
export interface ProcessInfo {
    readonly pid: number;
    readonly ppid: number;
    readonly started: number;
    readonly name: string;
}

export interface ReapResult {
    killed: number;
    /** True when the reap was declined as unsafe. `reason` says why, for a surface to report. */
    refused: boolean;
    reason?: string;
}

/** The OS calls, injected so the safety rules above are testable without touching a machine. */
export interface ProcessTreeIo {
    /** Every process on the machine. May throw; callers treat a throw as "cannot look". */
    snapshot(): ProcessInfo[];
    /** Terminate exactly this pid. Not its tree. Never throws for an already-dead pid. */
    killOne(pid: number): void;
}

/**
 * How many processes ONE session may ask to reap before the request is disbelieved.
 *
 * Nine provider processes is the measured real case. The number is a judgement, and the tests pin both sides of it: a
 * six-process session reaps on a desktop with 165 other processes, a forty-process session subtree refuses.
 */
export const PLAUSIBLE_REAP = 24;

/** The same process: the pid alone is not an identity on an OS that recycles pids. */
export function sameProcess(a: ProcessInfo, b: ProcessInfo): boolean {
    return a.pid === b.pid && a.started === b.started && a.name === b.name;
}

/** `p` as it appears in `table`, if the same process is there. */
export function findIn(table: readonly ProcessInfo[], p: ProcessInfo): ProcessInfo | undefined {
    return table.find((q) => sameProcess(q, p));
}

/** Of `known`, the ones still running in `now` (the same process, not merely the same pid). */
export function stillRunning(known: readonly ProcessInfo[], now: readonly ProcessInfo[]): ProcessInfo[] {
    return known.filter((p) => findIn(now, p) !== undefined);
}

/** Processes by pid, the first of each kept: `a` then whatever of `b` is not already in it. */
export function unionOf(a: readonly ProcessInfo[], b: readonly ProcessInfo[]): ProcessInfo[] {
    const out = [...a];
    for (const p of b) if (!out.some((q) => sameProcess(q, p))) out.push(p);
    return out;
}

/** How a list of processes reads in a log line or a reason: `1234(claude.exe), 1240(node.exe)`. */
export function describeProcesses(list: readonly ProcessInfo[]): string {
    return list.map((p) => `${p.pid}(${p.name})`).join(', ');
}

/**
 * `roots` and everything under them in one reading — the tree they own AT THIS MOMENT, however its members came to be
 * there (a provider its shell launched later, a re-exec, a tool's child). A root not in the reading as the same process
 * has no tree. A child that started before its parent is not its child (a recycled parent pointer).
 */
export function subtreeOf(table: readonly ProcessInfo[], roots: readonly ProcessInfo[]): ProcessInfo[] {
    const children = new Map<number, ProcessInfo[]>();
    for (const p of table) {
        const list = children.get(p.ppid);
        if (list) list.push(p);
        else children.set(p.ppid, [p]);
    }
    const out: ProcessInfo[] = [];
    const seen = new Set<number>();
    const queue: ProcessInfo[] = roots.flatMap((r) => { const live = findIn(table, r); return live ? [live] : []; });
    while (queue.length > 0) {
        const p = queue.shift()!;
        if (seen.has(p.pid)) continue;
        seen.add(p.pid);
        out.push(p);
        for (const child of children.get(p.pid) ?? []) {
            if (child.pid !== p.pid && child.started >= p.started) queue.push(child);
        }
    }
    return out;
}

/**
 * The processes that are NEW in `after` and DIRECT children of `parentPid` — what a spawn made, and nothing a sibling
 * did in the same instant (another agent's tool, a terminal's command: those appear deeper, under their own parents).
 */
export function newChildrenOf(before: readonly ProcessInfo[], after: readonly ProcessInfo[], parentPid: number): ProcessInfo[] {
    return after.filter((p) => p.ppid === parentPid && findIn(before, p) === undefined);
}

export function makeProcessTree(io: ProcessTreeIo): ProcessTree {
    return {
        snapshot() {
            try {
                return io.snapshot();
            } catch {
                return null;
            }
        },

        // `limit`: the cap, `PLAUSIBLE_REAP` unless the caller's targets are each RECORDED processes (the boot sweep).
        killTree(targets, now, limit = PLAUSIBLE_REAP) {
            // Nothing to do, and no reason to read the machine to find that out.
            if (targets.length === 0) return { killed: 0, refused: false };

            if (targets.length > limit) {
                return {
                    killed: 0,
                    refused: true,
                    reason:
                        `Refusing to reap ${targets.length} processes for one session — more than ` +
                        `${limit} means its tree is not what it seems. The provider's own kill has already run.`,
                };
            }

            let killed = 0;
            for (const target of targets) {
                // The same process in a reading taken just before — a pid that exited and had its number reused would
                // otherwise be somebody else's process, and on this machine that is another agent's work.
                if (!findIn(now, target)) continue;
                io.killOne(target.pid);
                killed += 1;
            }
            return { killed, refused: false };
        },
    };
}

/**
 * Windows: ONE `Get-CimInstance Win32_Process` read, everything else in JavaScript (the old scan walked parents in
 * PowerShell, O(n²)). The scan's own PowerShell, and anything under it, is left out — THE OBSERVER EFFECT, measured
 * 2026-10-10: counting it made a clean stop look like two survivors.
 */
function win32Snapshot(): ProcessInfo[] {
    const script = [
        '$ErrorActionPreference = "Stop";',
        '"self|$PID";',
        '$epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc);',
        'Get-CimInstance Win32_Process | ForEach-Object {',
        '  $ms = 0; if ($_.CreationDate) { $ms = [long]($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds };',
        '  "$($_.ProcessId)|$($_.ParentProcessId)|$ms|$($_.Name)"',
        '}',
    ].join(' ');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
    });
    return parseWin32Snapshot(out, process.pid);
}

/** The Windows scan's output, parsed: `self|<scanner pid>` then `pid|ppid|startedMs|name` per process. */
export function parseWin32Snapshot(out: string, selfPid: number): ProcessInfo[] {
    let scanner = -1;
    const rows: ProcessInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split('|');
        if (parts[0] === 'self') { scanner = Number(parts[1]); continue; }
        if (parts.length < 4) continue;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        const started = Number(parts[2]);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(started)) continue;
        rows.push({ pid, ppid, started, name: parts.slice(3).join('|') });
    }
    // A reading always includes the process taking it. One that does not is not a reading.
    if (!rows.some((r) => r.pid === selfPid)) throw new Error('the process listing did not include Genie itself');
    const scan = rows.find((r) => r.pid === scanner);
    const mine = new Set(scan ? subtreeOf(rows, [scan]).map((p) => p.pid) : [scanner]);
    return rows.filter((r) => !mine.has(r.pid));
}

/**
 * Linux and macOS: one `ps` (no shell — the old scan ran a login shell per descendant, recursively, which cost seconds
 * per stop). `lstart` is the start time to the second, in the C locale. The `ps` itself is left out.
 */
function posixSnapshot(): ProcessInfo[] {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], {
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    return parsePosixSnapshot(out, process.pid);
}

/** `ps -A -o pid=,ppid=,lstart=,comm=` parsed; the `ps` this process ran is left out. */
export function parsePosixSnapshot(out: string, selfPid: number): ProcessInfo[] {
    const rows: ProcessInfo[] = [];
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const started = Date.parse(m[3]!);
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), started: Number.isFinite(started) ? started : 0, name: m[4]!.trim() });
    }
    if (!rows.some((r) => r.pid === selfPid)) throw new Error('the process listing did not include Genie itself');
    return rows.filter((r) => !(r.ppid === selfPid && /(^|\/)ps$/.test(r.name)));
}

export const systemProcessTree: ProcessTree = makeProcessTree({
    snapshot: () => (process.platform === 'win32' ? win32Snapshot() : posixSnapshot()),

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
                execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 20_000, windowsHide: true });
            } else {
                process.kill(pid, 'SIGKILL');
            }
        } catch {
            // Already gone is the common case and is a success, not an error.
        }
    },
});
