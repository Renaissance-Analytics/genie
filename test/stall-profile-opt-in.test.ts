import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_START_MS, stallStacksWanted, startStallProfiler, type CpuProfile, type InspectorSessionLike } from '../src/main/stall-profile.js';

/**
 * genie#1606: THE PROFILER'S OWN CALLS MUST NOT HOLD MAIN PAST THE BOUND. On the Windows VM a capture's Profiler.stop and
 * the restart inside its callback held the window's main 1,893.6 ms; the nested Profiler.start alone 1,487.5 ms, though the
 * first start at boot was 39.6 ms. A start's cost grows as the app warms and is only known after it is paid, so no check
 * before a start can bound it. So: main's stack sampling is OFF unless asked for (GENIE_STALL_STACKS=1, for a diagnostic
 * run), the watchdog's stall lines staying on; and when asked for, a stop that already held main past the bound turns the
 * profiler off instead of starting again.
 */
const emptyProfile: CpuProfile = { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 } }], startTime: 0, endTime: 0, samples: [], timeDeltas: [] };

function rig(cost: { start: number; stop: number }) {
    let clock = 1_000_000;
    const posts: string[] = [];
    const lines: string[] = [];
    const session: InspectorSessionLike = {
        connect: () => {},
        post: (method, _params, callback) => {
            posts.push(method);
            if (method === 'Profiler.start') clock += cost.start;
            if (method === 'Profiler.stop') clock += cost.stop;
            callback(null, method === 'Profiler.stop' ? { profile: emptyProfile } : {});
        },
    };
    const profiler = startStallProfiler(session, (line) => lines.push(line), () => {}, { now: () => clock });
    return { profiler, posts, lines, starts: () => posts.filter((p) => p === 'Profiler.start').length };
}

describe('stack sampling is asked for, never on by default', () => {
    it('off with no GENIE_STALL_STACKS; on only with exactly 1', () => {
        expect(stallStacksWanted({})).toBe(false);
        expect(stallStacksWanted({ GENIE_STALL_STACKS: '0' })).toBe(false);
        expect(stallStacksWanted({ GENIE_STALL_STACKS: 'yes' })).toBe(false);
        expect(stallStacksWanted({ GENIE_STALL_STACKS: '1' })).toBe(true);
    });

    it('main starts the profiler only when asked; the watchdog is wired either way', () => {
        const main = readFileSync('src/main/main.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(main).toMatch(/if \(stallStacksWanted\(process\.env\)\) stallProfiler = startStallProfiler\(new InspectorSession\(\), lifecycleLog\);/);
        expect(main).toMatch(/onMainStall: \(ms\) => stallProfiler\?\.capture\(ms\)/);
    });
});

describe('when asked for: a stop past the bound is not followed by a start', () => {
    it('a capture whose stop held main past the bound turns the profiler off, said once, and starts nothing again', () => {
        const r = rig({ start: 5, stop: MAX_START_MS + 400 });
        expect(r.starts()).toBe(1);
        r.profiler.capture(2_000);
        expect(r.starts()).toBe(1);
        expect(r.lines.filter((l) => /stall profiler off: its own stop held main \d+ ms/.test(l))).toHaveLength(1);
    });

    it('CONTROL: a cheap stop is followed by its restart, as before', () => {
        const r = rig({ start: 5, stop: 5 });
        r.profiler.capture(2_000);
        expect(r.starts()).toBe(2);
        expect(r.lines).toEqual([]);
    });
});
