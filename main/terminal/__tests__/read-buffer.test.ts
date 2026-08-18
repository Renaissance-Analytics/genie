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
