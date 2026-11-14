import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { lineTransport } from '../src/core/line-transport.js';

/**
 * A LARGE FRAME COSTS ITS OWN SIZE, NOT ITS SIZE SQUARED (Tynn #662).
 *
 * The owner's 61.2, 2026-11-12: window main went 1955 -> 3617 MB within a minute and hung, and twice vanished after ~10 s
 * without a beat; its RSS spiked to 1.5-2.1 GB and back all day while its page stayed near 300 MB. Window main is where
 * genie-host's frames land, one per line on the engine pipe, and some are megabytes: the stores' dump at every connect
 * (his inbox alone is a 14 MB mail.json), an attention change (its decided questions and handoffs, 4 MB), a 200-row
 * ledger frame. The reader did `buffer += chunk; buffer.indexOf('\n')` on every chunk the pipe delivered, and V8 FLATTENS
 * the joined string to search it: a new copy of everything waiting, per chunk. A line of L characters read in chunks of
 * c costs about L^2 / 2c characters copied, each copy a large-object-space string that only a full GC frees.
 *
 * Measured against the unavoidable cost on the same machine (join the chunks once and decode them), so the bound holds on
 * a slow VM as on a fast one.
 */

class FakeStream extends EventEmitter {
    write(): boolean { return true; }
    end(): void { this.emit('close'); }
    destroy(): void { this.emit('close'); }
}

/** One frame of `chars` characters, no newline, TWO-BYTE in V8 as Genie's words are (curly quotes). */
function frameOf(chars: number): string {
    const unit = '{"from":"agent_x","text":"the suite’s output, read against the plan before the next step"},';
    return `{"kind":"event","channel":"stores.dump","payload":[${unit.repeat(Math.ceil(chars / unit.length))}`.slice(0, chars);
}

/** The pipe's reads: `size` characters each (a Windows named pipe hands a reader 64 KB at a time). */
function chunksOf(text: string, size: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
}

function timed(fn: () => void): number {
    const t = performance.now();
    fn();
    return performance.now() - t;
}

describe('the line transport reads a large frame in time linear in its size (Tynn #662)', () => {
    // The owner's dump-sized frame: 24 M characters, read 64 K at a time (375 reads).
    const CHARS = 24 * 1024 * 1024;
    const CHUNK = 64 * 1024;
    const frame = frameOf(CHARS);
    const chunks = chunksOf(frame, CHUNK);
    const tail = chunks.length;

    it('delivers the frame whole, once, and costs at most a few times joining its chunks once', () => {
        // The floor: what any reader must do, the chunks joined once and decoded once. The best of three.
        let floor = Number.POSITIVE_INFINITY;
        for (let k = 0; k < 3; k += 1) floor = Math.min(floor, timed(() => { Buffer.concat(chunks.map((c) => Buffer.from(c, 'utf8'))).toString('utf8'); }));

        const stream = new FakeStream();
        const t = lineTransport(stream);
        t.trusted();
        const got: string[] = [];
        t.onMessage((m) => got.push(m));
        const spent = timed(() => {
            for (let i = 0; i < tail; i += 1) stream.emit('data', chunks[i]);
            stream.emit('data', '\n');
        });

        expect(got).toHaveLength(1);
        expect(got[0]!.length).toBe(CHARS);
        expect(got[0] === frame).toBe(true);
        // Before: 375 reads each copied everything waiting, about 4.6 G characters for this frame (seconds, GBs of garbage).
        expect(spent, `framing took ${Math.round(spent)} ms; joining the chunks once takes ${Math.round(floor)} ms`).toBeLessThan(6 * floor + 150);
    }, 120_000);

    it('a multi-byte character split across two reads arrives whole (the reader joins bytes, then decodes)', () => {
        const stream = new FakeStream();
        const t = lineTransport(stream);
        const got: string[] = [];
        t.onMessage((m) => got.push(m));
        const bytes = Buffer.from('{"t":"it’s"}\n', 'utf8');
        const cut = bytes.indexOf(0x80); // inside the three bytes of ’
        stream.emit('data', bytes.subarray(0, cut));
        stream.emit('data', bytes.subarray(cut));
        expect(got).toEqual(['{"t":"it’s"}']);
    });

    it('frames, and the bytes after the last newline, in one read and across many', () => {
        const stream = new FakeStream();
        const t = lineTransport(stream);
        const got: string[] = [];
        t.onMessage((m) => got.push(m));
        stream.emit('data', Buffer.from('{"a":1}\n{"b"'));
        stream.emit('data', Buffer.from(':2}'));
        stream.emit('data', Buffer.from('\n\n{"c":3}\n{"d"'));
        expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
        stream.emit('data', ':4}\n');
        expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
    });
});
