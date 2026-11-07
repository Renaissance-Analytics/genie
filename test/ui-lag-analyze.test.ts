import { describe, expect, it } from 'vitest';
import { budgetVerdict, createGapGauge, firstSampleWith, indexProfile, pagingVerdict, summarize, windowProfile, worstGaps, type CpuProfile } from '../scripts/perf-lag/ui-lag-analyze.mjs';

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
