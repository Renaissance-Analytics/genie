import { describe, expect, it } from 'vitest';
import { TerminalReadBuffer, CAP_BYTES } from '../read-buffer';

describe('TerminalReadBuffer', () => {
    it('returns appended output and advances the cursor', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'hello ');
        b.append('t1', 'world');
        const r = b.readSince('t1', 0);
        expect(r.data).toBe('hello world');
        expect(r.cursor).toBe(11);
        expect(r.dropped).toBe(false);
    });

    it('readSince returns only what is new since the cursor', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'abc');
        const first = b.readSince('t1', 0);
        expect(first.data).toBe('abc');
        b.append('t1', 'def');
        const second = b.readSince('t1', first.cursor);
        expect(second.data).toBe('def');
        expect(second.cursor).toBe(6);
    });

    it('an up-to-date cursor yields nothing new', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'xyz');
        const r = b.readSince('t1', 3);
        expect(r.data).toBe('');
        expect(r.cursor).toBe(3);
        expect(r.dropped).toBe(false);
    });

    it('an undefined cursor reads from the oldest retained byte', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'first');
        const r = b.readSince('t1'); // no cursor → everything we hold
        expect(r.data).toBe('first');
    });

    it('returns empty (not throwing) for an unknown terminal, and says it is unbuffered', () => {
        const b = new TerminalReadBuffer();
        // buffered:false is the whole point — an empty read for a terminal we
        // hold nothing for must not look like an empty read for a quiet one.
        expect(b.readSince('nope', 0)).toEqual({
            data: '',
            cursor: 0,
            dropped: false,
            buffered: false,
        });
        expect(b.readTail('nope')).toEqual({
            data: '',
            cursor: 0,
            dropped: false,
            buffered: false,
        });
        expect(b.cursor('nope')).toBe(0);
        expect(b.has('nope')).toBe(false);
    });

    it('reports buffered:true for a terminal it holds, even with nothing new', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'abc');
        const caughtUp = b.readSince('t1', 3);
        expect(caughtUp.data).toBe('');
        expect(caughtUp.buffered).toBe(true);
    });

    it('caps retained bytes and drops the oldest beyond the cap', () => {
        const cap = 10;
        const b = new TerminalReadBuffer(cap);
        b.append('t1', '0123456789'); // exactly cap
        b.append('t1', 'ABCDE'); // pushes 5 oldest out
        // Total seen is 15; we retain the last 10: '56789ABCDE'.
        const tail = b.readTail('t1');
        expect(tail.data).toBe('56789ABCDE');
        expect(tail.cursor).toBe(15);
    });

    it('flags dropped when the cursor predates the retained window', () => {
        const cap = 10;
        const b = new TerminalReadBuffer(cap);
        b.append('t1', '0123456789'); // cursor 0..10 held
        b.append('t1', 'ABCDE'); // now oldest held = offset 5
        // Ask from cursor 0 — bytes 0..4 were evicted.
        const r = b.readSince('t1', 0);
        expect(r.dropped).toBe(true);
        expect(r.data).toBe('56789ABCDE'); // only what we still hold
        expect(r.cursor).toBe(15);
    });

    it('readTail with a byte count returns the last N and flags a slice', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'abcdefghij');
        const r = b.readTail('t1', 3);
        expect(r.data).toBe('hij');
        expect(r.dropped).toBe(true); // older bytes intentionally omitted
    });

    it('readTail without a count returns all held and flags dropped only if trimmed', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'short');
        expect(b.readTail('t1').dropped).toBe(false); // nothing was ever dropped
    });

    it('forget drops a terminal buffer', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'data');
        expect(b.size()).toBe(1);
        b.forget('t1');
        expect(b.size()).toBe(0);
        expect(b.readSince('t1', 0).data).toBe('');
    });

    it('exposes a generous default cap', () => {
        expect(CAP_BYTES).toBe(256 * 1024);
    });

    it('seed populates a MISSING buffer from surviving scrollback', () => {
        const b = new TerminalReadBuffer();
        expect(b.seed('t1', 'history from the pty host')).toBe(true);
        const r = b.readSince('t1', 0);
        expect(r.data).toBe('history from the pty host');
        expect(r.cursor).toBe(25);
        expect(r.buffered).toBe(true);
    });

    it('seed never clobbers a live buffer (no duplicated output, no rewound cursor)', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', 'live bytes');
        expect(b.seed('t1', 'live bytes')).toBe(false);
        expect(b.readSince('t1', 0).data).toBe('live bytes');
        expect(b.cursor('t1')).toBe(10);
    });

    it('seed trims scrollback larger than the cap and keeps the cursor honest', () => {
        const b = new TerminalReadBuffer(4);
        expect(b.seed('t1', 'abcdefgh')).toBe(true);
        const r = b.readSince('t1', 0);
        expect(r.data).toBe('efgh'); // last cap bytes
        expect(r.cursor).toBe(8); // cursor space covers everything seeded
        expect(r.dropped).toBe(true); // and it says the earlier bytes are gone
    });

    it('seed ignores empty scrollback (nothing to restore)', () => {
        const b = new TerminalReadBuffer();
        expect(b.seed('t1', '')).toBe(false);
        expect(b.has('t1')).toBe(false);
    });

    it('trimToTail keeps only the final bytes but leaves the cursor space intact', () => {
        const b = new TerminalReadBuffer();
        b.append('t1', '0123456789');
        b.trimToTail('t1', 4);
        const r = b.readTail('t1');
        expect(r.data).toBe('6789');
        expect(r.cursor).toBe(10);
        expect(b.has('t1')).toBe(true); // still tracked — the tail is the evidence
    });

    it('cursor reports total bytes ever seen', () => {
        const b = new TerminalReadBuffer(4);
        b.append('t1', 'aaaa');
        b.append('t1', 'bbbb');
        expect(b.cursor('t1')).toBe(8); // monotonic even after trims
    });
});

/**
 * WHEN a terminal last spoke — the fact `diagnose` reads to tell a working agent
 * from one frozen on a prompt.
 *
 * Everything else in this buffer answers "what did it say"; nothing answered
 * "was that recent". An agent parked on a TUI dialog stays bound, joined and
 * booted, and every check Genie had said healthy while it sat there for hours.
 * A working TUI emits constantly — spinners, tool lines, redraws — so silence is
 * measurable, and this is where it is measured.
 */
describe('when a terminal last produced output', () => {
    /** A buffer on a clock the test drives, so no wall time is involved. */
    const atClock = () => {
        let t = 1_000;
        const buf = new TerminalReadBuffer(undefined, () => t);
        return { buf, tick: (ms: number) => (t += ms), at: () => t };
    };

    it('is null for a terminal that has never been seen', () => {
        expect(atClock().buf.lastAppendAt('nope')).toBeNull();
    });

    it('records the moment output arrived', () => {
        const { buf, at } = atClock();
        buf.append('t1', 'hello');

        expect(buf.lastAppendAt('t1')).toBe(at());
    });

    it('moves forward with each new chunk', () => {
        const { buf, tick, at } = atClock();
        buf.append('t1', 'first');
        const first = buf.lastAppendAt('t1');
        tick(5_000);
        buf.append('t1', 'second');

        expect(buf.lastAppendAt('t1')).toBe(at());
        expect(buf.lastAppendAt('t1')).not.toBe(first);
    });

    it('does NOT move for an empty append, which is not output', () => {
        const { buf, tick } = atClock();
        buf.append('t1', 'hello');
        const spoke = buf.lastAppendAt('t1');
        tick(9_000);
        buf.append('t1', '');

        expect(buf.lastAppendAt('t1')).toBe(spoke);
    });

    it('stays null for a buffer SEEDED from restored scrollback', () => {
        // The decisive case. Restored history is output from before this process
        // existed; dating it "now" would make a terminal silent for hours look
        // like it just spoke, and hand `diagnose` the false reassurance this
        // whole field exists to remove.
        const { buf } = atClock();

        expect(buf.seed('t1', 'pages of old output')).toBe(true);
        expect(buf.lastAppendAt('t1')).toBeNull();
    });

    it('starts reporting once a seeded terminal actually speaks', () => {
        // POSITIVE CONTROL for the case above: null must mean "has not spoken",
        // not "seeded terminals are invisible forever".
        const { buf, tick, at } = atClock();
        buf.seed('t1', 'old output');
        tick(3_000);
        buf.append('t1', 'new output');

        expect(buf.lastAppendAt('t1')).toBe(at());
    });
});
