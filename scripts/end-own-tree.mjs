#!/usr/bin/env node
/**
 * A ROW ENDS WHAT IT STARTED, WAITS FOR IT, AND SAYS SO (Tynn #1031, genie#2147). On Windows the row scripts ended their
 * own Genie with `taskkill /T /F /PID <app>`, its answer thrown away, then the host by the pid in its record, and left.
 * Two gates failed `local-door` on the row guard ("LEFT RUNNING after the row") with every check passing:
 *
 *   - 1123-070157-9d5293, `electron … --updater`. genie-host is not in the app's process tree (measured, 12 of 12 runs:
 *     alive after the app's tree kill), and its updater helper is started detached through the host's spawn host, so the
 *     cleanup ended neither the helper nor waited for it. The helper leaves by itself when the host's link closes
 *     (measured, queue item 1123-151458-c9e688, 11 of 11: "updater: the host's link closed; leaving", 58 to 78 ms before
 *     the guard looked). The product ties it to the host; the row lost a 70 ms race.
 *   - 1123-141923-9a7aa2, the row's own app. The cleanup took its usual 0.1 s, so taskkill had answered, and the app was
 *     still running. What taskkill said was not kept, and nothing looked.
 *
 * So, one cleanup for every row that starts its own Genie:
 *   1. the process table is read BEFORE anything is ended: only then is the tree whole (a child keeps the parent pid it
 *      was started with, but a parent that has gone cannot be asked for its children);
 *   2. the app's tree is ended with taskkill, and its status, what it ended and its errors are logged, every time;
 *   3. whatever of this run is still alive is ended by pid, and what taskkill left of the app's own tree is NAMED;
 *   4. the table is read again, until nothing of this run is in it, within a bound. A process started meanwhile by one
 *      of this run's is found by its parent pid and ended too.
 * Still there at the bound: named, and the answer is not ok, so the row fails by its own words. The row guard in
 * scripts/ci/windows.ps1 is untouched and still fails a row that leaves anything of Genie running.
 *
 * ONLY THIS RUN'S: a process is taken when it is a given root or was started by one already taken, AND was created after
 * the run began (`since`): a pid the machine handed out again to something older is never ours. Never by a name or a
 * pattern, so another Genie on the machine is not touched.
 *
 * From a .ps1 row:  node scripts/end-own-tree.mjs --since <unix ms> --tree <app pid> [--root <pid> ...] [--bound <ms>]
 * exits 0 when nothing of the run is left, 1 when something is (named), 2 on a bad call.
 */
import { execFile, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ pid: number, ppid: number, created: number, name: string, cmd: string }} ProcessRow */

/** How the table is asked for: one line per process, the command line last because it may hold any character. */
export const TABLE_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; "$($_.ProcessId)|$($_.ParentProcessId)|$c|$($_.Name)|$($_.CommandLine)" }';

/** @param {string} text @returns {ProcessRow[]} */
export function parseProcessTable(text) {
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
        const m = /^(\d+)\|(\d+)\|(\d+)\|([^|]*)\|(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]), name: m[4], cmd: m[5].trim() });
    }
    return rows;
}

/**
 * This run's processes in a table: the roots, and everything started by one of them, created after the run began.
 * `roots` may name pids that are no longer in the table: their children are still theirs.
 * @param {ReadonlyArray<ProcessRow>} rows @param {ReadonlyArray<number>} roots @param {number} since
 * @returns {Map<number, ProcessRow>}
 */
export function treeOf(rows, roots, since) {
    const ours = (r) => r.created >= since;
    const parents = new Set(roots);
    const own = new Map();
    for (const r of rows) if (parents.has(r.pid) && ours(r)) own.set(r.pid, r);
    // A root pid now held by something older than the run is not a parent of ours either.
    for (const r of rows) if (parents.has(r.pid) && !ours(r)) parents.delete(r.pid);
    for (let grew = true; grew;) {
        grew = false;
        for (const r of rows) {
            if (own.has(r.pid) || !parents.has(r.ppid) || !ours(r)) continue;
            const parent = own.get(r.ppid);
            if (parent && parent.created > r.created) continue;
            own.set(r.pid, r); parents.add(r.pid); grew = true;
        }
    }
    return own;
}

const brief = (p) => `${p.name} ${p.pid} (parent ${p.ppid}) ${p.cmd.length > 260 ? `${p.cmd.slice(0, 260)}…` : p.cmd}`;
const lines = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * @param {{ roots: ReadonlyArray<{ pid: number | null | undefined, what: string }>, treeRoot?: number | null, since: number, boundMs?: number, ports: import('./end-own-tree.d.mts').EndPorts }} input
 * @returns {Promise<{ ok: boolean, left: ProcessRow[], ended: number, ms: number, words: string }>} words: what is left, for the row's own failure line
 */
export async function endOwnTree({ roots, treeRoot = null, since, boundMs = 15_000, ports }) {
    const began = ports.now();
    const rootPids = roots.map((r) => r.pid).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    /** Every process of this run ever seen, by pid. */
    const own = new Map();
    let reads = 0;
    let unread = null;
    const read = async () => {
        try {
            const rows = await ports.table(); reads += 1; unread = null;
            for (const [pid, r] of treeOf(rows, [...rootPids, ...own.keys()], since)) if (!own.has(pid)) own.set(pid, r);
            // In the table now, and the same process (not its pid handed out again).
            return rows.filter((r) => own.get(r.pid)?.created === r.created);
        } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            if (why !== unread) ports.log(`shutdown: the process table could not be read: ${why}`);
            unread = why;
            return null;
        }
    };

    let running = await read();
    if (running !== null && running.length === 0) {
        ports.log(`shutdown: nothing of this run was running (${roots.map((r) => `${r.what} ${r.pid ?? 'unknown'}`).join(', ')})`);
        return { ok: true, left: [], ended: 0, ms: ports.now() - began, words: '' };
    }
    if (running !== null) {
        const count = new Map();
        for (const p of running) count.set(p.name, (count.get(p.name) ?? 0) + 1);
        ports.log(`shutdown: this run's own processes: ${running.length} (${[...count].map(([n, c]) => `${n} x${c}`).join(', ')}); ${roots.map((r) => `${r.what} ${r.pid ?? 'unknown'}`).join(', ')}`);
    }

    // The app's tree, the way the rows always ended it; its answer kept.
    const appTree = treeRoot && running !== null ? new Set(treeOf(running, [treeRoot], since).keys()) : new Set();
    if (treeRoot && (running === null || appTree.size > 0)) {
        const r = ports.taskkillTree(treeRoot);
        const ended = lines(r.out).map((l) => /PID (\d+)/.exec(l)?.[1]).filter(Boolean);
        const errors = [...lines(r.out).filter((l) => !/^SUCCESS/i.test(l)), ...lines(r.err)];
        ports.log(`shutdown: taskkill /T /F /PID ${treeRoot}: status ${r.status} in ${r.ms} ms; ended ${ended.length}${ended.length ? ` (${ended.map(Number).sort((a, b) => a - b).join(' ')})` : ''}; ${errors.length ? `its words: ${errors.join(' | ')}` : 'no errors'}`);
        const leftBehind = [...appTree].filter((pid) => ports.alive(pid)).map((pid) => own.get(pid));
        if (leftBehind.length) ports.log(`shutdown: taskkill left running ${leftBehind.length} of the app's own tree, ended by pid: ${leftBehind.map(brief).join('; ')}`);
    }
    // A table that could not be read still gets the old cleanup: the roots by pid.
    const endAlive = (pids) => { const hit = []; for (const pid of pids) if (ports.alive(pid)) { try { ports.kill(pid); } catch { /* gone meanwhile */ } hit.push(pid); } return hit; };
    // The host and what it started are not under the app (the host is detached): each by its pid, and named.
    const outside = running === null ? [] : [...own.values()].filter((p) => !appTree.has(p.pid) && ports.alive(p.pid));
    if (outside.length) ports.log(`shutdown: outside the app's tree, ended by pid: ${outside.map(brief).join('; ')}`);
    endAlive(running === null ? rootPids : own.keys());

    for (let pass = 1; ; pass++) {
        // Cheap first: each of ours by its pid, until none answers or the bound; the table is the verdict.
        while ([...own.keys()].some((pid) => ports.alive(pid)) && ports.now() - began < boundMs) await ports.sleep(25);
        running = await read();
        if (running !== null && running.length === 0) {
            ports.log(`shutdown: all ${own.size} of this run's processes are gone, ${ports.now() - began} ms after the cleanup began (${reads} process-table reads)`);
            return { ok: true, left: [], ended: own.size, ms: ports.now() - began, words: '' };
        }
        if (ports.now() - began >= boundMs) {
            const ms = ports.now() - began;
            if (running === null) {
                const words = `the process table could not be read (${unread}), so what is left of this run is not known`;
                ports.log(`shutdown: NOT CONFIRMED after ${ms} ms: ${words}`);
                return { ok: false, left: [], ended: own.size, ms, words };
            }
            const words = running.map(brief).join('; ');
            ports.log(`shutdown: STILL RUNNING after ${ms} ms: ${words}`);
            return { ok: false, left: running, ended: own.size - running.length, ms, words };
        }
        if (running !== null) {
            const again = endAlive(running.map((p) => p.pid));
            if (pass > 1 || again.length) ports.log(`shutdown: still in the process table on read ${reads}${again.length ? ', ended by pid' : ', already ending'}: ${running.map(brief).join('; ')}`);
        } else endAlive(rootPids);
        await ports.sleep(250);
    }
}

/** The machine's own: PowerShell's table, taskkill, and a pid ended at once. */
export function windowsPorts(log) {
    return {
        table: () => new Promise((resolve, reject) => {
            execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', TABLE_SCRIPT], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
                if (error) { reject(new Error(error.killed ? 'PowerShell took over 60 s' : String(error.message).split(/\r?\n/)[0].slice(0, 200))); return; }
                const rows = parseProcessTable(stdout);
                if (rows.length === 0) reject(new Error('PowerShell printed no process')); else resolve(rows);
            });
        }),
        taskkillTree: (pid) => {
            const t0 = Date.now();
            const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
            return { status: r.status, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`, ms: Date.now() - t0 };
        },
        kill: (pid) => { process.kill(pid, 'SIGKILL'); },
        alive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
        log,
    };
}

/**
 * A row's whole cleanup on Windows: its app (with its tree), its host by the pid in the run's own record, and any other
 * pid the row itself started. `since` is when the row script began.
 * @param {{ app?: { pid?: number } | null, hostPid?: number | null, others?: ReadonlyArray<number>, since: number, boundMs?: number, log?: (line: string) => void }} input
 */
export async function endOwnRun({ app = null, hostPid = null, others = [], since, boundMs, log = (line) => { console.log(line); } }) {
    if (process.platform !== 'win32') throw new Error('endOwnRun is the Windows cleanup; elsewhere a row ends its process group');
    const roots = [{ pid: app?.pid ?? null, what: 'the app' }, { pid: hostPid, what: 'genie-host' }, ...others.map((pid) => ({ pid, what: 'started by the row' }))];
    return endOwnTree({ roots, treeRoot: app?.pid ?? null, since, ...(boundMs === undefined ? {} : { boundMs }), ports: windowsPorts(log) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const all = (flag) => args.flatMap((a, i) => (a === flag ? [Number(args[i + 1])] : []));
    const since = all('--since')[0];
    const tree = all('--tree')[0] ?? null;
    const extra = all('--root');
    const bound = all('--bound')[0];
    if (!Number.isFinite(since) || [tree ?? 1, ...extra, bound ?? 1].some((n) => !Number.isSafeInteger(n) || n < 1) || (tree === null && extra.length === 0)) {
        console.error('usage: node scripts/end-own-tree.mjs --since <unix ms> [--tree <app pid>] [--root <pid> ...] [--bound <ms>]');
        process.exit(2);
    }
    const roots = [...(tree === null ? [] : [{ pid: tree, what: 'the app' }]), ...extra.map((pid) => ({ pid, what: 'named' }))];
    const r = await endOwnTree({ roots, treeRoot: tree, since, ...(bound === undefined ? {} : { boundMs: bound }), ports: windowsPorts((line) => { console.log(line); }) });
    process.exit(r.ok ? 0 : 1);
}
