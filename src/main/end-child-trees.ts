import { findIn, type ProcessInfo, type ProcessTree } from '../core/process-tree.js';

/**
 * ENDING A CHILD AND EVERYTHING IT STARTED, by the process tree's rules (pid, start time and name; no `/T`). Written for
 * git reads at their limit (git-ports.ts, #1638), and used by every command Genie runs at its limit (spawn-exec.ts, Tynn
 * #698): an installer or npm past its limit is ended with what it started, not only the cmd.exe in front of it.
 */

/** What a child must offer to be ended: its pid, whether it is still running, its kill and its exit. */
export interface EndableChild {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * Of `table`, every process that is ours: started by one of `ours` (by its parent's pid, and no earlier than that parent,
 * so a reused pid is not taken for a child) — whether or not that parent is still running, since Windows keeps a process's
 * parent id after the parent is gone. Added to `ours`; the newcomers are returned.
 */
function growOurs(ours: Map<number, ProcessInfo>, table: readonly ProcessInfo[]): ProcessInfo[] {
    const added: ProcessInfo[] = [];
    for (let changed = true; changed;) {
        changed = false;
        for (const p of table) {
            if (ours.has(p.pid)) continue;
            const parent = ours.get(p.ppid);
            if (parent && p.pid !== parent.pid && p.started >= parent.started) { ours.set(p.pid, p); added.push(p); changed = true; }
        }
    }
    return added;
}

/**
 * Readings taken while ending one read's tree, for what it started meanwhile, and the wall time they may take: a SAFETY
 * STOP on the walk, never a cap on how many are ended. Every process the walk finds is a descendant of our git by pid,
 * start time and name, so a big tree is still ours: a cap on the count would let a hook that forks past it keep running
 * in the repository (#1638's review).
 */
const GIT_TREE_ROUNDS = 8;
const GIT_TREE_WALL_MS = 10_000;
/** How long the limit waits for a read's launcher to be gone (its job closed) before the walk; it is ended at once. */
const GIT_JOB_END_WAIT_MS = 5_000;

/**
 * What the limit ends: git, and what git started under it, a hook's child above all, which keeps the folder open and
 * would never end by itself. NOTHING IT STARTED ESCAPES, even what it starts while it is being ended (the line's run after
 * #1637: git gone, and its hook's sh chain — git's second call of the hook — still running in the repository). One
 * reading, then the kill, left that window: whatever started between the two was in no reading.
 *
 * So the tree is taken from a first reading (git and every descendant, by parent pid and start time), then read AGAIN
 * after each round, and anything a process of ours started is ours too — until a reading finds nothing new. On Windows
 * each round ENDS what is known: a process keeps its parent's id when that parent is gone, so a child started at the last
 * moment is still found by it. Elsewhere each round STOPS what is known first (SIGSTOP: a stopped process starts nothing,
 * and its children keep their parent, where a killed parent's would be handed to init and lost to the walk); then all of
 * it ends together. Always through the tree's rules (`core/process-tree.ts`): the same process by pid, start time and
 * name, no `/T`. A child that a hook detached before the first reading is not found. A job object would close even that
 * (noted for #1628's launcher).
 */
export async function endChildTrees(children: readonly EndableChild[], tree: ProcessTree, platform: NodeJS.Platform = process.platform, jobs: ReadonlySet<EndableChild> = new Set()): Promise<void> {
    const running = children.filter((child) => child.exitCode === null && child.signalCode === null && child.pid !== undefined);
    if (running.length === 0) return;
    // THE JOB FIRST, before anything in it (Windows, genie-launch.exe `job`). The launcher keeps its job's kill only while
    // git runs: when git ends, the launcher lifts the kill and exits, and what git started is left running. So git must
    // never end before its launcher. The walk below ended both at once, each by its own taskkill, and lost that race twice
    // in 20 runs (run 42363613581: all 230 of a hook's children alive 40 s after the limit). Ending the launcher here ends
    // its process with the kill still set, so the job ends everything in it. Waited for (bounded), then the walk takes
    // whatever is left outside the job.
    const jobbed = running.filter((child) => jobs.has(child));
    if (jobbed.length > 0) {
        await Promise.all(jobbed.map((child) => new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, GIT_JOB_END_WAIT_MS);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            child.kill();
        })));
    }
    const read = async (): Promise<readonly ProcessInfo[] | null> => (tree.read ? tree.read() : tree.snapshot());
    // Every one identified is ended: the tree's count limit is lifted (it guards a session's guess, not a verified walk).
    const end = async (targets: readonly ProcessInfo[], now: readonly ProcessInfo[]): Promise<void> => {
        if (targets.length === 0) return;
        if (tree.reap) await tree.reap(targets, now, Number.MAX_SAFE_INTEGER);
        else tree.killTree(targets, now, Number.MAX_SAFE_INTEGER);
    };
    const stop = (targets: readonly ProcessInfo[], now: readonly ProcessInfo[]): void => {
        for (const p of targets) { if (findIn(now, p)) { try { process.kill(p.pid, 'SIGSTOP'); } catch { /* gone */ } } }
    };
    const ours = new Map<number, ProcessInfo>();
    try {
        let table = await read();
        if (table === null) return;
        const pids = new Set(running.map((child) => child.pid));
        for (const p of table) if (pids.has(p.pid)) ours.set(p.pid, p);
        growOurs(ours, table);
        const until = Date.now() + GIT_TREE_WALL_MS;
        for (let round = 0; round < GIT_TREE_ROUNDS && Date.now() < until; round += 1) {
            const known = [...ours.values()];
            if (platform === 'win32') await end(known, table);
            else stop(known, table);
            const next = await read();
            if (next === null) break;
            table = next;
            if (growOurs(ours, table).length === 0) break;
        }
        // Whatever of ours is still there, ended together (on Windows, what the last round missed; elsewhere, all of it).
        const left = [...ours.values()].filter((p) => findIn(table!, p));
        await end(left, table);
        if (ours.size > 24) console.error(`[end-child-trees] a command past its limit had started ${ours.size} processes; all of them were ended`);
    } finally {
        // Whatever the readings could not find or refused: git itself still ends.
        for (const child of running) child.kill();
    }
}
