import { describe, expect, it, vi } from 'vitest';
import { budgetVerdict, capVerdict, createGapGauge, heldVerdict, firstSampleWith, indexProfile, pagingVerdict, pageVerdict, pushVerdict, retryOnTimeout, sliceVerdict, summarize, throughputVerdict, traceSummary, windowProfile, worstGaps, type CpuProfile } from '../scripts/perf-lag/ui-lag-analyze.mjs';

/*
 * THE UI-LAG ROW'S GAUGES READ WHAT THEY CLAIM (Tynn #274 / #429). The row in scripts/ui-lag-cdp.mjs decides on these
 * numbers — a window main block over 50 ms during a write-heavy build fails it — so each is shown here to produce the
 * value it reports, ONE included: a gauge that reads zero and many correctly can still read a single gap as nothing.
 */

describe('the gap gauge', () => {
    it('reads no gap, exactly one gap, and several, with their lateness', () => {
        let t = 0;
        const g = createGapGauge({ intervalMs: 10, thresholdMs: 20, now: () => t });
        for (let i = 0; i < 5; i += 1) { t += 10; g.beat(); }
        expect(g.snapshot().gaps).toEqual([]);
        t += 70; g.beat(); // 60 ms late
        expect(g.snapshot().gaps).toEqual([{ startedMs: 50, endedMs: 120, ms: 60 }]);
        t += 10; g.beat();
        t += 40; g.beat(); // 30 ms late
        t += 25; g.beat(); // 15 ms late: under the threshold
        const s = g.snapshot();
        expect(s.gaps.map((x) => x.ms)).toEqual([60, 30]);
        expect(s.worstMs).toBe(60);
        expect(s.ticks).toBe(9);
    });

    it('counts what it could not keep, and reset starts over', () => {
        let t = 0;
        const g = createGapGauge({ intervalMs: 10, thresholdMs: 0, cap: 2, now: () => t });
        for (let i = 0; i < 4; i += 1) { t += 50; g.beat(); }
        expect(g.snapshot().gaps).toHaveLength(2);
        expect(g.snapshot().dropped).toBe(2);
        g.reset();
        expect(g.snapshot()).toEqual({ ticks: 0, dropped: 0, worstMs: 0, gaps: [] });
    });

    it('is self-contained, so it can be sent into a page or main as its source text', () => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const rebuilt = new Function(`return (${createGapGauge.toString()})`)() as typeof createGapGauge;
        let t = 0;
        const g = rebuilt({ intervalMs: 10, thresholdMs: 5, now: () => t });
        t += 30; g.beat();
        expect(g.snapshot().gaps).toEqual([{ startedMs: 0, endedMs: 30, ms: 20 }]);
    });
});

describe('the worst gaps and the budget', () => {
    const gaps = [{ startedMs: 0, endedMs: 60, ms: 50 }, { startedMs: 100, endedMs: 190, ms: 80 }, { startedMs: 500, endedMs: 520, ms: 10 }];

    it('keeps only the gaps inside the window, longest first', () => {
        expect(worstGaps(gaps, 90, 600).map((g) => g.ms)).toEqual([80, 10]);
        expect(worstGaps(gaps, 0, 600, 1).map((g) => g.ms)).toEqual([80]);
    });

    it('fails on one gap over the budget, and passes at the budget itself', () => {
        expect(budgetVerdict(gaps, 50)).toEqual({ ok: false, budgetMs: 50, over: 1, worstMs: 80 });
        expect(budgetVerdict([gaps[0]!], 50)).toEqual({ ok: true, budgetMs: 50, over: 0, worstMs: 50 });
        expect(budgetVerdict([], 50).ok).toBe(true);
    });
});

describe('the percentiles', () => {
    it('reads one value, many, and none', () => {
        expect(summarize([7])).toEqual({ count: 1, p50: 7, p95: 7, max: 7 });
        const many = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(summarize(many)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
        expect(summarize([])).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
    });
});

describe('what a profile says a thread was doing', () => {
    // root > main > [busyLoop > leaf, onFiles (files-host.js)], (idle), (program)
    const profile: CpuProfile = {
        nodes: [
            { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 6, 7] },
            { id: 2, callFrame: { functionName: 'main', url: 'file:///app/dist/main/main.js', lineNumber: 9 }, children: [3, 5] },
            { id: 3, callFrame: { functionName: 'uiLagControlBusy', url: '', lineNumber: 0 }, children: [4] },
            { id: 4, callFrame: { functionName: 'leaf', url: '', lineNumber: 0 } },
            { id: 5, callFrame: { functionName: 'state', url: 'file:///app/dist/main/files-host.js', lineNumber: 41 } },
            { id: 6, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
            { id: 7, callFrame: { functionName: '(program)', url: '', lineNumber: -1 } },
        ],
        startTime: 1_000_000, // µs
        endTime: 1_020_000,
        // one sample per ms: 3 idle, 5 control, 4 state, 2 program, 2 idle
        samples: [6, 6, 6, 4, 4, 4, 4, 4, 5, 5, 5, 5, 7, 7, 6, 6],
        timeDeltas: Array(16).fill(1000),
    };
    const index = indexProfile(profile);

    it('finds the alignment marker by its function name, and nothing for a name that is not there', () => {
        expect(firstSampleWith(index, 'uiLagControlBusy')).toBe(1004);
        expect(firstSampleWith(index, 'absent')).toBeNull();
    });

    it('splits a window into JS, native and idle time, with the heaviest stack leaf first and Genie\'s own frame', () => {
        const w = windowProfile(index, 1004, 1016, { isOwn: (f) => /files-host\.js|main\.js/.test(f) });
        expect(w.ms).toEqual({ js: 9, program: 2, gc: 0, idle: 1 });
        expect(w.stacks[0]).toEqual({ ms: 5, stack: 'leaf < uiLagControlBusy < main main.js:10' });
        expect(w.stacks[1]).toEqual({ ms: 4, stack: 'state files-host.js:42 < main main.js:10' });
        expect(w.ownFrames[0]).toEqual({ ms: 5, frame: 'main main.js:10' });
        expect(w.ownFrames[1]).toEqual({ ms: 4, frame: 'state files-host.js:42' });
    });

    it('a window with only one busy sample still names it', () => {
        const w = windowProfile(index, 1009, 1009.5);
        expect(w.samples).toBe(1);
        expect(w.stacks).toEqual([{ ms: 1, stack: 'state files-host.js:42 < main main.js:10' }]);
    });

    it('a source map renames a frame', () => {
        const mapped = indexProfile(profile, (f) => (f.functionName === 'state' ? 'FilesHost.state src/main/files-host.ts:412' : null));
        expect(windowProfile(mapped, 1013, 1013.5).stacks).toEqual([]); // native time names no JS stack
        expect(windowProfile(mapped, 1009, 1009.5).stacks[0]!.stack).toBe('FilesHost.state src/main/files-host.ts:412 < main main.js:10');
    });
});

describe('the Files state paging budget (Tynn #522)', () => {
    it('passes a bounded cost that does not grow, and names each way it fails', () => {
        expect(pagingVerdict([{ pass: 'a', states: 40, pageNext: 200 }, { pass: 'b', states: 40, pageNext: 240 }]).ok).toBe(true);
        // The measured cost before the cursor: 66 per call, doubling with the session.
        const before = pagingVerdict([{ pass: 'a', states: 46, pageNext: 3042 }, { pass: 'b', states: 46, pageNext: 6084 }]);
        expect(before.ok).toBe(false);
        expect(before.reasons).toEqual(['a: 66.1 pages per files.state (bound 16)', 'b: 132.3 pages per files.state (bound 16)', 'b: 132.3 pages per files.state grew from 66.1']);
        // Growth alone, under the bound.
        expect(pagingVerdict([{ pass: 'a', states: 10, pageNext: 20 }, { pass: 'b', states: 10, pageNext: 150 }]).reasons).toEqual(['b: 15 pages per files.state grew from 2']);
        // Nothing read: nothing measured, never a pass.
        expect(pagingVerdict([{ pass: 'a', states: 0, pageNext: 0 }]).reasons).toEqual(['a: no files.state call during the build']);
    });
});

describe('the Files push budget (Tynn #523)', () => {
    it('passes small pushes with one whole tree among them, and names each way it fails', () => {
        const small = Array.from({ length: 40 }, () => 10_000);
        expect(pushVerdict([{ pass: 'a', sizes: [150_000, ...small] }]).ok).toBe(true);
        // The measured pushes before: every one carried the whole tree.
        const before = pushVerdict([{ pass: 'a', sizes: Array.from({ length: 40 }, () => 140_000) }]);
        expect(before.reasons).toEqual(['a: p95 140000 bytes per Files push (bound 32768)', 'a: mean 140000 bytes per Files push (bound 24576)']);
        expect(pushVerdict([{ pass: 'a', sizes: [30_000, 30_000, 30_000] }]).reasons).toEqual(['a: mean 30000 bytes per Files push (bound 24576)']);
        expect(pushVerdict([{ pass: 'a', sizes: [] }]).reasons).toEqual(['a: no Files push during the build']);
    });
});

describe('the page budget while a terminal streams (Tynn #525)', () => {
    it('passes within the slack of idle, and names each way it fails', () => {
        expect(pageVerdict({ idle: { count: 50, p95: 45 }, streaming: { count: 50, p95: 52, worstFrameGapMs: 83 } }).ok).toBe(true);
        // The measured page before (Linux): p95 66.5 against idle 45.2, a 117 ms frame gap.
        expect(pageVerdict({ idle: { count: 50, p95: 45.2 }, streaming: { count: 50, p95: 66.5, worstFrameGapMs: 117 } }).reasons).toEqual([
            'mouse to frame p95 66.5 ms while the terminal streams, idle 45.2 ms (bound idle + 10)',
            'a frame gap of 117 ms while the terminal streams (bound 100)',
        ]);
        expect(pageVerdict({ idle: { count: 0, p95: 0 }, streaming: { count: 50, p95: 10, worstFrameGapMs: 0 } }).ok).toBe(false);
    });
});

describe('the page budget from interleaved slices (Tynn #536)', () => {
    const slice = (p95: number, worstGapMs = 0, count = 30) => ({ count, p95, worstGapMs });
    it('the terminal\'s cost under the same load: medians, so one bad slice is not a verdict', () => {
        // A slow runner: everything is slow, on and off alike. Not the terminal's cost.
        expect(sliceVerdict({ on: [slice(64), slice(66), slice(65)], off: [slice(63), slice(62), slice(64)] }).ok).toBe(true);
        // One bad slice among good ones does not fail it.
        expect(sliceVerdict({ on: [slice(20), slice(90, 120), slice(21)], off: [slice(18), slice(19), slice(18)] }).ok).toBe(true);
        // The old per-chunk render: every "on" slice slower than the "off" slice beside it.
        expect(sliceVerdict({ on: [slice(60, 100), slice(62, 117), slice(66, 117)], off: [slice(44), slice(45), slice(46)] }).reasons).toEqual([
            'mouse to frame p95, median of 3 paired differences: the terminal on screen 17 ms over off (bound 10; on 62, off 45)',
            'worst frame gap, median of 3 slices with the terminal on screen: 117 ms (bound 100)',
        ]);
        // PAIRED: a runner that slows down during the build moves both slices of a pair, not the verdict.
        expect(sliceVerdict({ on: [slice(30), slice(50), slice(70)], off: [slice(25), slice(45), slice(65)] }).diffs).toEqual([5, 5, 5]);
        expect(sliceVerdict({ on: [slice(30), slice(50), slice(70)], off: [slice(25), slice(45), slice(65)] }).ok).toBe(true);
        // A pair with no input on one side does not count.
        expect(sliceVerdict({ on: [slice(1), slice(1, 0, 0), slice(1)], off: [slice(1), slice(1), slice(1)] }).reasons).toEqual(['too few pairs with input on both sides: 2 (need 3)']);
    });
});

describe('the throughput budget: input the page keeps up with, terminal on against off (Tynn #537)', () => {
    const slice = (count: number) => ({ count, p95: 20, worstGapMs: 0 });
    it('passes pairs that keep up, fails the halved throughput Linux measured, and needs enough pairs', () => {
        // Windows, run 42488024371: 67-72 events acknowledged on against 71-74 off.
        expect(throughputVerdict({ on: [slice(70), slice(72), slice(67)], off: [slice(73), slice(72), slice(72)] }).ok).toBe(true);
        // Linux, the same run: 29-41 on against 55-59 off.
        const linux = throughputVerdict({ on: [slice(29), slice(36), slice(30)], off: [slice(55), slice(56), slice(57)] });
        expect(linux.ok).toBe(false);
        expect(linux.ratio).toBe(0.53);
        expect(linux.reasons).toEqual(['mouse events acknowledged, median of 3 paired ratios: the terminal on screen 0.53 of off (bound 0.9; on 30, off 56)']);
        // ONE slow pair among good ones does not fail it; the median of the ratios decides.
        expect(throughputVerdict({ on: [slice(70), slice(20), slice(70)], off: [slice(72), slice(72), slice(72)] }).ok).toBe(true);
        // PAIRED: a runner that slows down during the build moves both slices of a pair.
        expect(throughputVerdict({ on: [slice(60), slice(40), slice(20)], off: [slice(62), slice(41), slice(21)] }).ok).toBe(true);
        // An "off" slice with no input says nothing about the pair.
        expect(throughputVerdict({ on: [slice(1), slice(1), slice(1)], off: [slice(1), slice(0), slice(1)] }).reasons).toEqual(['too few pairs with input off screen: 2 (need 3)']);
        // An "on" slice with NO input is the worst case, not a missing one: it counts, as 0.
        expect(throughputVerdict({ on: [slice(0), slice(0), slice(70)], off: [slice(70), slice(70), slice(70)] }).ratio).toBe(0);
    });
});

describe('the terminal past its output cap, against itself hidden AT THE SAME MOMENTS (Tynn #692)', () => {
    /*
     * The past-cap slices used to be one phase of their own, compared with below-cap slices taken a minute earlier: a slower
     * minute on the machine read as a cost of the cap (Azure run 2: 0.79; run 3: 1.02). Now each past slice has a control
     * next to it in time, the same terminal still streaming past the cap with its pane hidden, and the verdict reads the
     * PAIRS: each past slice against its own control.
     */
    const slice = (count: number, scriptMsPerS = 60, worstGapMs = 0) => ({ count, p95: 20, worstGapMs, scriptMsPerS });
    const paired = { paired: true, control: 'its pane hidden at the same moments' } as const;
    it('a machine that slows down halfway moves both sides of each pair, and passes', () => {
        const control = [slice(70), slice(71), slice(69), slice(40), slice(38), slice(41)];
        const past = [slice(69), slice(70), slice(70), slice(39), slice(38), slice(40)];
        const v = capVerdict({ below: control, past }, paired);
        expect(v.reasons).toEqual([]);
        expect(v.ratio).toBe(0.99);
        // CONTROL: the same slices read unpaired (medians of each side) fail on the slowdown alone.
        expect(capVerdict({ below: [slice(70), slice(71), slice(69), slice(70), slice(70), slice(71)], past }).ok).toBe(false);
    });
    it('a past side that falls behind its own controls fails, in words that name the control', () => {
        const v = capVerdict({ below: [slice(70), slice(71), slice(69)], past: [slice(50), slice(52), slice(49)] }, paired);
        expect(v.ok).toBe(false);
        expect(v.reasons).toEqual(['mouse events acknowledged past the output cap: 0.71 of its pane hidden at the same moments, median of 3 pairs (bound 0.9; past 50, control 70)']);
    });
    it('script time is read by pair too: over its own control by more than the bound fails', () => {
        // Pair differences 40, 40, 280: the median is 40, under the bound. Unpaired, the same slices fail (340 against 120).
        const below = [slice(70, 100), slice(70, 300), slice(70, 120)], past = [slice(70, 140), slice(70, 340), slice(70, 400)];
        expect(capVerdict({ below, past }, paired).reasons).toEqual([]);
        expect(capVerdict({ below, past }).ok).toBe(false);
        const busy = capVerdict({ below: [slice(70, 100), slice(70, 100), slice(70, 100)], past: [slice(70, 200), slice(70, 220), slice(70, 180)] }, paired);
        expect(busy.reasons).toEqual(['page script time past the output cap: 100 ms per second over its pane hidden at the same moments, median of 3 pairs (bound 50; past 200, control 100)']);
    });
    it('needs as many controls as past slices, and enough of them', () => {
        expect(capVerdict({ below: [slice(70), slice(70)], past: [slice(70), slice(70), slice(70)] }, paired).reasons).toEqual(['too few pairs: 2 past slices with a control beside them (need 3)']);
    });
});

describe('the terminal past its output cap, against below it (Tynn #542)', () => {
    const slice = (count: number, worstGapMs = 0, scriptMsPerS = 60) => ({ count, p95: 20, worstGapMs, scriptMsPerS });
    it('fails a page whose script time past the cap is far over below it, though its input keeps up (run 0d892cff)', () => {
        // Run 0d892cff, profiled pass: past the cap the page ran 4385 ms of script in 9.7 s (xterm parsing the whole kept
        // output again every batch); below it about 5%. Its input kept up at 0.88.
        const busy = capVerdict({ below: [slice(73, 0, 50), slice(72, 0, 55), slice(73, 0, 48)], past: [slice(64, 0, 450), slice(66, 0, 430), slice(63, 0, 470)] }, { minRatio: 0.85 });
        expect(busy.reasons).toEqual(['page script time past the output cap: 400 ms per second over below it, median (bound 50; past 450, below 50)']);
        expect(capVerdict({ below: [slice(73, 0, 50), slice(72, 0, 55), slice(73, 0, 48)], past: [slice(72, 0, 70), slice(73, 0, 90), slice(72, 0, 60)] }).ok).toBe(true);
        // A slice whose script time was not measured is not a pass.
        expect(capVerdict({ below: [slice(73), slice(72), slice(73)], past: [{ count: 72, p95: 20, worstGapMs: 0 }, slice(73), slice(72)] }).reasons).toEqual(['page script time not measured in every slice']);
    });
    it('passes a terminal that keeps up past the cap, fails one that falls behind or drops frames, and needs enough slices', () => {
        expect(capVerdict({ below: [slice(72), slice(73), slice(71)], past: [slice(72), slice(70), slice(73)] }).ok).toBe(true);
        const behind = capVerdict({ below: [slice(72), slice(73), slice(71)], past: [slice(20), slice(25), slice(18)] });
        expect(behind.ok).toBe(false);
        expect(behind.ratio).toBe(0.28);
        expect(behind.reasons).toEqual(['mouse events acknowledged past the output cap: 0.28 of the slices below it (bound 0.9; past 20, below 72)']);
        expect(capVerdict({ below: [slice(72), slice(73), slice(71)], past: [slice(72, 150), slice(70, 160), slice(73, 0)] }).reasons).toEqual(['worst frame gap past the output cap, median of 3 slices: 150 ms (bound 100)']);
        expect(capVerdict({ below: [slice(72), slice(73)], past: [slice(72), slice(70), slice(73)] }).reasons).toEqual(['too few slices: 2 below the cap and 3 past it (need 3 each)']);
    });
});

describe('what a terminal view holds after a flood (Tynn #544)', () => {
    it('passes a view that keeps its cap, fails one that keeps everything, and needs both readings', () => {
        // 12 MB through a view that keeps 2,000,000 characters: within the cap and 4 MB besides.
        expect(heldVerdict({ floodBytes: 12_000_000, growthBytes: 3_100_000 }).ok).toBe(true);
        expect(heldVerdict({ floodBytes: 12_000_000, growthBytes: 12_400_000 }).reasons).toEqual(['the view held 12.4 MB more after a 12 MB flood (bound 6 MB: the 2 MB cap and 4 MB besides)']);
        expect(heldVerdict({ floodBytes: 12_000_000, growthBytes: Number.NaN }).reasons).toEqual(['the heap was not read before and after the flood']);
    });
});

describe('a trace, summarised by thread and by event (Tynn #537)', () => {
    it('names threads, sums each event, and counts a thread\'s time once when events nest', () => {
        const events = [
            { ph: 'M', name: 'thread_name', pid: 1, tid: 10, args: { name: 'CrRendererMain' } },
            { ph: 'M', name: 'thread_name', pid: 2, tid: 20, args: { name: 'VizCompositorThread' } },
            { ph: 'X', name: 'Paint', pid: 1, tid: 10, ts: 1000, dur: 4000 },
            // Nested inside the Paint: its own row, but not the thread's time twice.
            { ph: 'X', name: 'PaintImage', pid: 1, tid: 10, ts: 2000, dur: 1000 },
            { ph: 'X', name: 'Paint', pid: 1, tid: 10, ts: 10000, dur: 2000 },
            { ph: 'X', name: 'Draw', pid: 2, tid: 20, ts: 0, dur: 3000 },
            // No duration: not time.
            { ph: 'I', name: 'Mark', pid: 1, tid: 10, ts: 1 },
        ];
        const s = traceSummary(events, { top: 2 });
        expect(s.threads).toEqual([{ thread: 'CrRendererMain', ms: 6 }, { thread: 'VizCompositorThread', ms: 3 }]);
        expect(s.top).toEqual([{ thread: 'CrRendererMain', name: 'Paint', ms: 6, count: 2 }, { thread: 'VizCompositorThread', name: 'Draw', ms: 3, count: 1 }]);
        // A thread without a name event keeps its ids.
        expect(traceSummary([{ ph: 'X', name: 'Task', pid: 3, tid: 30, ts: 0, dur: 500 }]).threads).toEqual([{ thread: '3:30', ms: 0.5 }]);
    });
});

describe('the fixture git, bounded (Tynn #536)', () => {
    it('retries a timeout, resets between tries, and stops at the bound; any other failure at once', () => {
        const reset = vi.fn();
        let n = 0;
        const ok = retryOnTimeout(() => { n += 1; if (n === 1) throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }); return 'done'; }, { attempts: 2, reset });
        expect(ok.value).toBe('done');
        expect(ok.tries.map((t) => t.ok)).toEqual([false, true]);
        expect(reset).toHaveBeenCalledOnce();
        expect(() => retryOnTimeout(() => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); }, { attempts: 2 })).toThrow('x');
        let calls = 0;
        expect(() => retryOnTimeout(() => { calls += 1; throw new Error('not a repository'); }, { attempts: 3 })).toThrow('not a repository');
        expect(calls).toBe(1);
    });
});
