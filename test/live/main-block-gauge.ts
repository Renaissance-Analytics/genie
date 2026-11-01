/**
 * WHO IS HELD, AND DOING WHAT (genie#1397). A live harness's gauge for blocks of the process it runs in — Genie's main, in
 * a live test that composes Genie the way main.ts does. Three heartbeats, so a late timer can be told apart:
 *
 *  - MAIN: main's own StallWatchdog (src/main/stall-watchdog.ts, exactly as main.ts wires it) and V8's sampling profiler
 *    on main (src/main/stall-profile.ts's `blockStack`), read on every block over 1 s: the heaviest stack, plus a
 *    histogram of what the samples in the block were (`(program)` = native code outside JS, `(garbage collector)`, or
 *    a JS frame) and the longest gap between two samples (the profiler's own thread not running at all).
 *  - WORKER: a heartbeat on a worker thread of the SAME process. Main held while the worker ticks on = main's THREAD is
 *    held (something it runs). Both held = the whole process is not being scheduled.
 *  - PROCESS: a heartbeat in a SEPARATE node process. Held too = the machine (the VM) is starved, not Genie.
 *
 * Each heartbeat writes `<epoch ms> <late ms>` for every tick 200 ms or more late; `report(since)` reads the worst of each
 * since a mark. Nothing here runs outside a live test on a test VM.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { StallWatchdog } from '../../src/main/stall-watchdog.js';
import { blockStack, type CpuProfile } from '../../src/main/stall-profile.js';

export interface BlockRecord {
    readonly at: number;
    readonly ms: number;
    /** main's `stall main stack …` line, or null when the block held no JS (blockStack found no busy run). */
    readonly stack: string | null;
    /** What the samples in the block were, heaviest first: `leaf < caller` → share. */
    readonly samples: string;
    /** The longest gap between two consecutive samples in the block (the sampler thread not running), ms. */
    readonly sampleGapMs: number;
}

export interface GaugeReport {
    readonly mainMs: number;
    /**
     * The worst main block BEYOND the machine: for each main block, its length minus how long the worker thread and the
     * separate process were held at the same moment (the lesser of the two). A held main thread reads its full length; a
     * VM that ran nothing reads about 0.
     */
    readonly ownMs: number;
    readonly workerMs: number;
    readonly processMs: number;
    readonly blocks: readonly BlockRecord[];
}

/** One heartbeat's source, run in a worker or a separate process: appends `<epoch> <late>` to `file` per late tick. */
const beatSource = (file: string) => `
const { appendFileSync } = require('node:fs');
let t = Date.now();
setInterval(() => {
    const n = Date.now();
    const late = n - t - 50;
    t = n;
    if (late >= 200) appendFileSync(${JSON.stringify(file)}, n + ' ' + late + '\\n');
}, 50);
`;

function lateTicks(file: string): Array<{ at: number; late: number }> {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return []; }
    return text.split('\n').map((line) => line.split(' ').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)).map(([at, late]) => ({ at: at!, late: late! }));
}

function worstSince(file: string, since: number): number {
    let worst = 0;
    // A tick that fired after `since` but whose gap began before it still counts for the part after `since`.
    for (const t of lateTicks(file)) if (t.at >= since) worst = Math.max(worst, Math.min(t.late, t.at - since));
    return worst;
}

/** How long a heartbeat was held during [start, end]: the overlap of its late gaps with that window, the longest one. */
function heldDuring(ticks: ReadonlyArray<{ at: number; late: number }>, start: number, end: number): number {
    let held = 0;
    for (const t of ticks) held = Math.max(held, Math.max(0, Math.min(end, t.at) - Math.max(start, t.at - t.late)));
    return held;
}

function histogram(profile: CpuProfile, fromUs: number): { samples: string; gapMs: number } {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const label = (id: number): string => {
        const f = byId.get(id)?.callFrame;
        if (!f) return '?';
        const file = f.url ? f.url.split(/[\\/]/).pop() : '';
        return `${f.functionName || '(anonymous)'}${file ? ` ${file}:${f.lineNumber + 1}` : ''}`;
    };
    const counts = new Map<string, number>();
    let t = 0;
    let total = 0;
    let gap = 0;
    let prev: number | null = null;
    for (let i = 0; i < profile.samples.length; i += 1) {
        t += profile.timeDeltas[i] ?? 0;
        if (t < fromUs) continue;
        if (prev !== null) gap = Math.max(gap, t - prev);
        prev = t;
        const id = profile.samples[i]!;
        const up = parent.get(id);
        const key = up !== undefined && byId.get(up)?.callFrame.functionName !== '(root)' ? `${label(id)} < ${label(up)}` : label(id);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        total += 1;
    }
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${Math.round((n / Math.max(1, total)) * 100)}%`);
    return { samples: `${total} samples: ${top.join(' | ')}`, gapMs: Math.round(gap / 1000) };
}

export function startMainBlockGauge(): { report(since: number): Promise<GaugeReport>; stop(): void } {
    const dir = mkdtempSync(join(tmpdir(), 'genie-gauge-'));
    const workerFile = join(dir, 'worker.txt');
    const processFile = join(dir, 'process.txt');
    const worker = new Worker(beatSource(workerFile), { eval: true });
    worker.unref();
    const other = spawn(process.execPath, ['-e', beatSource(processFile)], { stdio: 'ignore', windowsHide: true });

    const session = new Session();
    session.connect();
    const post = <T>(method: string, params: object = {}): Promise<T> => new Promise((resolve, reject) => session.post(method, params, (error, result) => (error ? reject(error) : resolve(result as T))));
    let profiling = post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 10_000 })).then(() => post('Profiler.start'));
    const blocks: BlockRecord[] = [];
    const pending: Array<Promise<void>> = [];
    const capture = (ms: number): void => {
        const at = Date.now();
        const read = profiling.then(() => post<{ profile: CpuProfile }>('Profiler.stop')).then(({ profile }) => {
            const span = profile.endTime - profile.startTime;
            const found = blockStack(profile, Math.min(ms, 1_000) * 0.8);
            const h = histogram(profile, Math.max(0, span - (ms + 500) * 1000));
            blocks.push({ at, ms, stack: found?.line ?? null, samples: h.samples, sampleGapMs: h.gapMs });
        }).catch((error: unknown) => {
            blocks.push({ at, ms, stack: `profile unreadable: ${error instanceof Error ? error.message : String(error)}`, samples: '', sampleGapMs: 0 });
        });
        profiling = read.then(() => post('Profiler.start'));
        pending.push(read);
    };
    const mainBlocks: Array<{ at: number; ms: number }> = [];
    const dog = new StallWatchdog({
        log: (line) => {
            const m = /^stall main ms=(\d+)/.exec(line);
            if (m) mainBlocks.push({ at: Date.now(), ms: Number(m[1]) });
        },
        onMainStall: capture,
    });
    dog.start();
    return {
        async report(since) {
            // A block's stack is read after it ends; let the last one land.
            await new Promise((r) => setTimeout(r, 500));
            await Promise.all(pending.splice(0));
            const mine = mainBlocks.filter((b) => b.at >= since);
            const workerTicks = lateTicks(workerFile);
            const processTicks = lateTicks(processFile);
            // A main block of `ms` ended at `at` (the watchdog's beat): its window, widened by one beat on each side.
            const own = mine.map((b) => {
                const start = b.at - b.ms - 400;
                const machine = Math.min(heldDuring(workerTicks, start, b.at + 200), heldDuring(processTicks, start, b.at + 200));
                return Math.max(0, b.ms - machine);
            });
            return {
                mainMs: Math.max(0, ...mine.map((b) => Math.min(b.ms, b.at - since))),
                ownMs: Math.max(0, ...own),
                workerMs: worstSince(workerFile, since),
                processMs: worstSince(processFile, since),
                blocks: blocks.filter((b) => b.at >= since),
            };
        },
        stop() {
            dog.stop();
            void worker.terminate();
            other.kill();
            session.disconnect();
        },
    };
}

/** The report as lines for the log. */
export function describeGauge(r: GaugeReport): string[] {
    const lines = [`gauge: worst main block ${r.mainMs} ms (beyond the machine: ${r.ownMs} ms); worker thread (same process) ${r.workerMs} ms; separate process ${r.processMs} ms`];
    for (const b of r.blocks) {
        lines.push(`  block ${b.ms} ms (longest gap between samples ${b.sampleGapMs} ms)`);
        lines.push(`    ${b.stack ?? 'no busy JS run in the block (blockStack: null)'}`);
        lines.push(`    ${b.samples}`);
    }
    return lines;
}
