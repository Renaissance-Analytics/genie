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

    it('returns empty (not throwing) for an unknown terminal', () => {
        const b = new TerminalReadBuffer();
        expect(b.readSince('nope', 0)).toEqual({ data: '', cursor: 0, dropped: false });
        expect(b.readTail('nope')).toEqual({ data: '', cursor: 0, dropped: false });
        expect(b.cursor('nope')).toBe(0);
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

    it('cursor reports total bytes ever seen', () => {
        const b = new TerminalReadBuffer(4);
        b.append('t1', 'aaaa');
        b.append('t1', 'bbbb');
        expect(b.cursor('t1')).toBe(8); // monotonic even after trims
    });
});
