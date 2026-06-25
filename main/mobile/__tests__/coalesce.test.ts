import { describe, expect, it } from 'vitest';
import { CoalesceBuffer } from '../terminal-bridge';

/**
 * The per-socket coalesce buffer is the backpressure floor: a chatty pty must
 * never grow it unboundedly, and when the cap evicts bytes the next drain must
 * surface `dropped` so the phone knows it missed output. Pure — driven directly.
 */

describe('CoalesceBuffer', () => {
    it('accumulates pushes and drains them in order', () => {
        const b = new CoalesceBuffer(1000);
        b.push('foo');
        b.push('bar');
        expect(b.hasPending).toBe(true);
        const out = b.drain();
        expect(out.data).toBe('foobar');
        expect(out.dropped).toBe(false);
        // Drained → empty + flag reset.
        expect(b.hasPending).toBe(false);
        expect(b.drain()).toEqual({ data: '', dropped: false });
    });

    it('caps retained bytes and latches `dropped` when older bytes are evicted', () => {
        const b = new CoalesceBuffer(8);
        b.push('abcdef'); // 6 — under cap
        b.push('ghij'); // total 10 > cap 8 → drop oldest 2
        const out = b.drain();
        expect(out.data).toBe('cdefghij'); // last 8 chars
        expect(out.data.length).toBe(8);
        expect(out.dropped).toBe(true);
    });

    it('clears the dropped flag after a drain', () => {
        const b = new CoalesceBuffer(4);
        b.push('123456'); // overflows → dropped
        expect(b.drain().dropped).toBe(true);
        b.push('ok');
        const out = b.drain();
        expect(out.data).toBe('ok');
        expect(out.dropped).toBe(false); // flag did not persist
    });

    it('ignores empty pushes', () => {
        const b = new CoalesceBuffer(10);
        b.push('');
        expect(b.hasPending).toBe(false);
    });

    it('handles a single push larger than the cap', () => {
        const b = new CoalesceBuffer(4);
        b.push('abcdefgh'); // 8 > 4
        const out = b.drain();
        expect(out.data).toBe('efgh');
        expect(out.dropped).toBe(true);
    });
});
