import { describe, expect, it } from 'vitest';
import { FALLBACK_MS, outputBatch } from '../src/renderer/terminal-output-batch.js';

/*
 * A TERMINAL'S OUTPUT, ONE RENDER PER FRAME (Tynn #525). The Workspace re-rendered synchronously on every chunk; the row
 * measured the page's mouse-to-frame p95 at 67-74 ms while a build streamed, against 45 ms idle. Chunks between two frames
 * are applied once now, and nothing is lost, reordered or kept without bound.
 */
function rig(cap = 1_000_000) {
    const applied: Array<Array<readonly [string, string]>> = [];
    const frames: Array<() => void> = [], timers: Array<{ fn: () => void; ms: number }> = [];
    const batch = outputBatch({
        cap, apply: (b) => applied.push([...b]),
        frame: (fn) => { frames.push(fn); return () => { const i = frames.indexOf(fn); if (i >= 0) frames.splice(i, 1); }; },
        later: (fn, ms) => { const t = { fn, ms }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }; },
    });
    const nextFrame = () => { for (const f of frames.splice(0)) f(); };
    return { batch, applied, frames, timers, nextFrame };
}

describe('outputBatch', () => {
    it('every chunk before a frame is applied once, joined, per terminal, in order', () => {
        const r = rig();
        for (let i = 0; i < 100; i += 1) r.batch.data('a', `${i},`);
        r.batch.data('b', 'B');
        expect(r.applied).toEqual([]);
        expect(r.frames).toHaveLength(1); // one frame asked for, however many chunks
        r.nextFrame();
        expect(r.applied).toEqual([[['a', Array.from({ length: 100 }, (_, i) => `${i},`).join('')], ['b', 'B']]]);
        expect(r.timers).toHaveLength(0); // the fallback was cancelled with it
        r.nextFrame();
        expect(r.applied).toHaveLength(1);
    });

    it('with no frames (a hidden window) the output is still applied, after the fallback', () => {
        const r = rig();
        r.batch.data('a', 'x');
        expect(r.timers.map((t) => t.ms)).toEqual([FALLBACK_MS]);
        r.timers[0]!.fn();
        expect(r.applied).toEqual([[['a', 'x']]]);
        expect(r.frames).toHaveLength(0);
    });

    it('flush applies what is held at once (an exit after it keeps its order); drop forgets one terminal\'s', () => {
        const r = rig();
        r.batch.data('a', 'before exit');
        r.batch.data('b', 'stale');
        r.batch.drop('b');
        r.batch.flush();
        expect(r.applied).toEqual([[['a', 'before exit']]]);
        r.batch.flush();
        expect(r.applied).toHaveLength(1);
    });

    it('what is held for one terminal keeps only its tail past the cap; closed, nothing is applied', () => {
        const r = rig(5);
        r.batch.data('a', 'abc');
        r.batch.data('a', 'defg');
        r.nextFrame();
        expect(r.applied).toEqual([[['a', 'cdefg']]]);
        r.batch.data('a', 'late');
        r.batch.close();
        r.nextFrame();
        for (const t of r.timers) t.fn();
        expect(r.applied).toHaveLength(1);
    });
});
