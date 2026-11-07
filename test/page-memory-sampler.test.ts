import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pageMemorySampler } from '../src/main/renderer-recovery.js';

/*
 * THE PAGE'S MEMORY IS A REAL READING OR NONE (the line's run on 3db9bc94, job 128263989997: the renderer-crash row's
 * record said `rendererMb: 0`). At did-finish-load app.getAppMetrics() may not list the page's new renderer yet, or list
 * it with a working set of 0, and that 0 overwrote everything. A reading that is missing or 0 now leaves the last real one
 * as it was; at did-finish-load the sampler tries again, a few hundred ms apart and bounded, until it reads a real value;
 * and what a crash record takes is the last real reading.
 */
function rig(readings: Array<number | null>) {
    let i = 0;
    const timers: Array<() => void> = [];
    const s = pageMemorySampler({
        read: () => (i < readings.length ? readings[i++]! : readings[readings.length - 1]!),
        later: (fn) => { timers.push(fn); },
    });
    const runTimers = (n = 100) => { for (let k = 0; k < n && timers.length; k++) timers.shift()!(); };
    return { s, runTimers, reads: () => i, pending: () => timers.length };
}

describe('the page\'s memory', () => {
    it('a reading of 0 or none never overwrites a real one', () => {
        const r = rig([812 * 1024 * 1024, 0, null]);
        r.s.sample();
        expect(r.s.bytes()).toBe(812 * 1024 * 1024);
        r.s.sample();
        r.s.sample();
        expect(r.s.bytes()).toBe(812 * 1024 * 1024);
        expect(r.s.mb()).toBe(812);
    });

    it('at did-finish-load it tries again until it reads a real value (0, none, then a real one)', () => {
        const r = rig([0, null, 0, 300 * 1024 * 1024]);
        r.s.loaded();
        expect(r.s.bytes()).toBeNull();
        r.runTimers();
        expect(r.s.bytes()).toBe(300 * 1024 * 1024);
        // ...and stops once it has one.
        expect(r.pending()).toBe(0);
    });

    it('the tries are bounded: a renderer that never shows a real value stops being asked', () => {
        const r = rig([0]);
        r.s.loaded();
        r.runTimers(1_000);
        expect(r.s.bytes()).toBeNull();
        expect(r.s.mb()).toBeNull();
        expect(r.reads()).toBeLessThanOrEqual(21);
        expect(r.pending()).toBe(0);
    });

    it('wired: main samples through it, and the crash record and the beat read its last real value', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/pageMemorySampler\(\{/);
        expect(main).toMatch(/win\.webContents\.on\('did-finish-load', \(\) => \{ pageMemory\.loaded\(\); \}\)/);
        expect(main).toMatch(/rendererMb: \(\) => pageMemory\.mb\(\)/);
        expect(main).toMatch(/rendererRss: \(\) => pageMemory\.bytes\(\)/);
    });
});
