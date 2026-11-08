import { describe, expect, it } from 'vitest';
import { outputStep, streamAppended, streamReplaced, type OutputStream } from '../src/core/terminal-output-stream.js';
import { outputViewObserver } from '../src/renderer/terminal-output-view.js';

/*
 * THE AGENT VIEW'S AND THE TAKE OVER WINDOW'S TERMINALS (Tynn #544). Each kept its terminal's whole output in one string
 * that only grew, re-rendered synchronously on every chunk, and handed fancy-term that string to compare with the last:
 * the comparison read all of it, every chunk. They now keep it as the Workspace does since #525 and #542: chunks joined
 * and applied once per batch, kept to the cap, and a stream position the pane writes the appended tail from.
 */

describe('the output stream', () => {
    it('a replacement starts a new epoch; an append counts in full, keeps the cap, and the pane writes only it', () => {
        let s = streamReplaced(null, 'hello');
        expect(s).toEqual({ text: 'hello', end: 5, epoch: 1 });
        s = streamAppended(s, ' world', 8);
        expect(s).toEqual({ text: 'lo world', end: 11, epoch: 1 });
        expect(outputStep({ text: 'hello', end: 5, epoch: 1 }, s)).toEqual({ reset: false, write: ' world' });
        expect(streamReplaced(s, 'snap')).toEqual({ text: 'snap', end: 4, epoch: 2 });
    });
});

function rig() {
    let stream: OutputStream | null = null;
    const renders: OutputStream[] = [], exits: Array<number | null> = [], errors: Array<string | null> = [];
    const timers: Array<() => void> = [];
    const observer = outputViewObserver({
        cap: 20,
        update: (fn) => { stream = fn(stream); renders.push(stream!); },
        exited: (code) => exits.push(code),
        error: (message) => errors.push(message),
        later: (fn) => { timers.push(fn); return () => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); }; },
    });
    return { observer, renders, exits, errors, tick: () => { for (const t of timers.splice(0)) t(); }, stream: () => stream };
}

describe('outputViewObserver', () => {
    it('applies the chunks of a batch in ONE update, not one per chunk', async () => {
        const r = rig();
        await r.observer.snapshot({ scrollback: 'start ' } as never);
        expect(r.renders).toHaveLength(1);
        for (let i = 0; i < 50; i += 1) await r.observer.data(`${i % 10}`);
        expect(r.renders).toHaveLength(1);
        r.tick();
        expect(r.renders).toHaveLength(2);
        // 6 + 50 characters arrived; the newest 20 are kept.
        expect(r.stream()).toEqual({ text: '01234567890123456789', end: 56, epoch: 1 });
    });

    it('an exit applies what is held first; a snapshot drops what was held before it and clears the exit and the error', async () => {
        const r = rig();
        await r.observer.snapshot({ scrollback: 'a' } as never);
        await r.observer.data('b');
        await r.observer.exit(3);
        expect(r.stream()).toEqual({ text: 'ab', end: 2, epoch: 1 });
        expect(r.exits).toEqual([null, 3]);
        r.observer.error(new Error('lost'));
        await r.observer.data('stale');
        await r.observer.snapshot({ scrollback: 'fresh' } as never);
        r.tick();
        expect(r.stream()).toEqual({ text: 'fresh', end: 5, epoch: 2 });
        expect(r.exits).toEqual([null, 3, null]);
        expect(r.errors).toEqual([null, 'lost', null]);
    });

    it('nothing is applied after close', async () => {
        const r = rig();
        await r.observer.snapshot({ scrollback: 'x' } as never);
        await r.observer.data('late');
        r.observer.close();
        r.tick();
        expect(r.stream()).toEqual({ text: 'x', end: 1, epoch: 1 });
    });
});
