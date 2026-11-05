import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPTURE_COOLDOWN_MS, MAX_START_MS, startStallProfiler, type CpuProfile, type InspectorSessionLike } from '../src/main/stall-profile.js';

/**
 * THE GAUGE MUST NOT BE THE STALL (genie-test-windows, job Q0, quit run 2, 2026-11-05). After "Shut down everything" the
 * window took 62 s to reach the host's shutdown, and the proof's 60 s ran out. Main was held for about 57 of those 62 s,
 * and 7 of the 9 stacks logged meanwhile were the stall profiler's OWN restart (`post node:inspector < begin < restart <
 * capture < onMainStall`), back to back about every 7 s. On that machine V8's Profiler.start held main for 5 to 7 s
 * (`stall main stack ms=5856 … ms=6934 … ms=5805 …`). The watchdog then saw that as a block and asked for a capture,
 * which restarted the profiler again: a loop that kept main from the quit's own steps.
 *
 * So: the profiler times its own start, and one that holds main for MAX_START_MS or more turns itself off and says so
 * once. A capture is not chased within CAPTURE_COOLDOWN_MS of the last one. And a quit stops it for good.
 */

const emptyProfile: CpuProfile = { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 } }], startTime: 0, endTime: 0, samples: [], timeDeltas: [] };

function rig(startCostMs: number) {
    let clock = 1_000_000;
    const posts: string[] = [];
    const scheduled: Array<() => void> = [];
    const lines: string[] = [];
    const session: InspectorSessionLike = {
        connect: () => {},
        post: (method, _params, callback) => {
            posts.push(method);
            if (method === 'Profiler.start') clock += startCostMs; // a synchronous post: main is held while V8 starts
            callback(null, method === 'Profiler.stop' ? { profile: emptyProfile } : {});
        },
    };
    const profiler = startStallProfiler(session, (line) => lines.push(line), (fn) => { scheduled.push(fn); }, { now: () => clock });
    return {
        profiler, posts, lines, scheduled,
        advance: (ms: number) => { clock += ms; },
        starts: () => posts.filter((p) => p === 'Profiler.start').length,
        stops: () => posts.filter((p) => p === 'Profiler.stop').length,
    };
}

describe('the stall profiler costs less than what it measures', () => {
    it('a start that holds main MAX_START_MS or more turns the profiler off, said once; nothing is restarted after', () => {
        const r = rig(6_000);
        expect(r.starts()).toBe(1);
        expect(r.lines.filter((l) => /stall profiler off/.test(l))).toHaveLength(1);
        expect(r.lines[0]).toMatch(/6000 ms/);
        r.profiler.capture(6_000);
        r.profiler.capture(6_000);
        for (const roll of r.scheduled) roll();
        expect(r.starts()).toBe(1);
        expect(r.lines.filter((l) => /stall profiler off/.test(l))).toHaveLength(1);
    });

    it('CONTROL: a cheap start keeps sampling, and a capture stops and restarts it', () => {
        const r = rig(5);
        expect(r.lines).toEqual([]);
        r.profiler.capture(2_000);
        expect(r.stops()).toBe(1);
        expect(r.starts()).toBe(2);
    });

    it('a capture within the cooldown of the last one is not chased; after it, it is', () => {
        const r = rig(5);
        r.profiler.capture(2_000);
        r.advance(1_000);
        r.profiler.capture(2_000);
        expect(r.stops()).toBe(1);
        r.advance(CAPTURE_COOLDOWN_MS);
        r.profiler.capture(2_000);
        expect(r.stops()).toBe(2);
    });

    it('stop(): sampling ends, and neither a capture nor the window’s roll starts it again', () => {
        const r = rig(5);
        r.profiler.stop();
        expect(r.stops()).toBe(1);
        r.advance(CAPTURE_COOLDOWN_MS);
        r.profiler.capture(2_000);
        for (const roll of r.scheduled) roll();
        expect(r.starts()).toBe(1);
    });

    it('the bound is below the measured cost and above a normal start', () => {
        expect(MAX_START_MS).toBeGreaterThanOrEqual(250);
        expect(MAX_START_MS).toBeLessThan(5_000);
    });
});

describe('wired: a quit stops the profiler before its own steps', () => {
    it('the quit’s shutdown pass stops it first, before the agents’ stops', () => {
        const main = readFileSync('src/main/main.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(main).toMatch(/if \(step === 'pass'\) return;\n(\s*\/\/[^\n]*\n)*\s*event\.preventDefault\(\);\n(\s*\/\/[^\n]*\n)*\s*stallProfiler\?\.stop\(\);\n\s*host\?\.stopAll\(\);/);
    });
});
