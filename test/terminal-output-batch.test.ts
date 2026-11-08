import { describe, expect, it } from 'vitest';
import { BATCH_MS, outputBatch } from '../src/renderer/terminal-output-batch.js';

/*
 * A TERMINAL'S OUTPUT, ONE RENDER PER BATCH (Tynn #525). The Workspace re-rendered synchronously on every chunk; the row
 * measured the page's mouse-to-frame p95 at 60-74 ms while a build streamed, against 44 ms idle. Chunks within a batch are
 * applied once now, in a task of their own, and nothing is lost, reordered or kept without bound.
 */
function rig(cap = 1_000_000) {
    const applied: Array<Array<readonly [string, string]>> = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const batch = outputBatch({
        cap, apply: (b) => applied.push([...b]),
        later: (fn, ms) => { const t = { fn, ms }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }; },
    });
    const tick = () => { for (const t of timers.splice(0)) t.fn(); };
    return { batch, applied, timers, tick };
}

describe('outputBatch', () => {
    it('every chunk within a batch is applied once, joined, per terminal, in order', () => {
        const r = rig();
        for (let i = 0; i < 100; i += 1) r.batch.data('a', `${i},`);
        r.batch.data('b', 'B');
        expect(r.applied).toEqual([]);
        expect(r.timers.map((t) => t.ms)).toEqual([BATCH_MS]); // one task asked for, however many chunks
        r.tick();
        expect(r.applied).toEqual([[['a', Array.from({ length: 100 }, (_, i) => `${i},`).join('')], ['b', 'B']]]);
        r.tick();
        expect(r.applied).toHaveLength(1);
        r.batch.data('a', 'next');
        r.tick();
        expect(r.applied).toEqual([[['a', Array.from({ length: 100 }, (_, i) => `${i},`).join('')], ['b', 'B']], [['a', 'next']]]);
    });

    it('flush applies what is held at once (an exit after it keeps its order); drop forgets one terminal\'s', () => {
        const r = rig();
        r.batch.data('a', 'before exit');
        r.batch.data('b', 'stale');
        r.batch.drop('b');
        r.batch.flush();
        expect(r.applied).toEqual([[['a', 'before exit']]]);
        expect(r.timers).toHaveLength(0);
        r.batch.flush();
        expect(r.applied).toHaveLength(1);
    });

    it('what is held for one terminal keeps only its tail past the cap; closed, nothing is applied', () => {
        const r = rig(5);
        r.batch.data('a', 'abc');
        r.batch.data('a', 'defg');
        r.tick();
        expect(r.applied).toEqual([[['a', 'cdefg']]]);
        r.batch.data('a', 'late');
        r.batch.close();
        r.tick();
        expect(r.applied).toHaveLength(1);
    });
});
