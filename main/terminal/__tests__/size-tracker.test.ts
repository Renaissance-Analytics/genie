import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    isUsableGrid,
    recordTerminalSize,
    getTerminalSize,
    getTerminalSizeHistory,
    forgetTerminalSize,
} from '../size-tracker';

/**
 * `isUsableGrid` is the single validator for every pty grid that crosses a
 * process or wire boundary — a remote spawn body, a `resize` frame, a tracked
 * size. It exists because a bogus grid must never reach the pty: forwarding
 * `0×0` would spawn an unusable terminal, while simply OMITTING it lets the
 * engine's 80×24 default apply. Pure — driven directly.
 */
describe('isUsableGrid', () => {
    it('accepts a real grid', () => {
        expect(isUsableGrid({ cols: 203, rows: 51 })).toBe(true);
    });

    it('rejects a missing grid (caller has not fitted yet)', () => {
        expect(isUsableGrid({})).toBe(false);
        expect(isUsableGrid({ cols: 80 })).toBe(false);
        expect(isUsableGrid({ rows: 24 })).toBe(false);
    });

    it('rejects zero and negative axes', () => {
        expect(isUsableGrid({ cols: 0, rows: 0 })).toBe(false);
        expect(isUsableGrid({ cols: 80, rows: 0 })).toBe(false);
        expect(isUsableGrid({ cols: -4, rows: 24 })).toBe(false);
    });

    it('rejects non-finite axes (NaN from a Number() of a junk wire field)', () => {
        expect(isUsableGrid({ cols: Number.NaN, rows: 24 })).toBe(false);
        expect(isUsableGrid({ cols: 80, rows: Number.POSITIVE_INFINITY })).toBe(false);
    });
});

describe('terminal size tracking', () => {
    it('records and returns a size', () => {
        recordTerminalSize('t-size-1', 120, 40);
        expect(getTerminalSize('t-size-1')).toEqual({ cols: 120, rows: 40 });
        forgetTerminalSize('t-size-1');
    });

    it('ignores a bogus size rather than recording it', () => {
        recordTerminalSize('t-size-2', 0, -1);
        expect(getTerminalSize('t-size-2')).toBeNull();
    });

    it('forgets a size so a reused id starts clean', () => {
        recordTerminalSize('t-size-3', 100, 30);
        forgetTerminalSize('t-size-3');
        expect(getTerminalSize('t-size-3')).toBeNull();
    });
});

/**
 * THE HISTORY ANSWERS A QUESTION THE LAST-APPLIED SIZE CANNOT (genie#542).
 *
 * `getTerminalSize` says where a pty is NOW. A test asserting a NON-EVENT — "the
 * panel a workspace switch hid never drove its pty" — is asking something else
 * entirely: was it EVER moved, and when. The last-applied size cannot tell a pty
 * that never moved from one that moved and was put back, and the E2E spec that
 * relied on it flaked for exactly that reason: it compared against a snapshot
 * taken before an earlier layout change had finished reaching the pty, so the
 * CORRECT resize arriving afterwards read as a fit against a hidden panel.
 *
 * Diagnostics only, so it is off unless `GENIE_E2E=1` — a long-lived session
 * pays nothing for a list only the suite reads.
 */
describe('terminal size history', () => {
    const saved = process.env.GENIE_E2E;
    beforeEach(() => {
        process.env.GENIE_E2E = '1';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.GENIE_E2E;
        else process.env.GENIE_E2E = saved;
        forgetTerminalSize('t-hist-1');
        forgetTerminalSize('t-hist-2');
        forgetTerminalSize('t-hist-3');
    });

    it('keeps every grid a pty was driven to, oldest first', () => {
        recordTerminalSize('t-hist-1', 72, 28);
        recordTerminalSize('t-hist-1', 103, 28);
        recordTerminalSize('t-hist-1', 72, 28);
        expect(getTerminalSizeHistory('t-hist-1').map((e) => e.cols)).toEqual([72, 103, 72]);
    });

    it('distinguishes a pty that never moved from one that moved and came back', () => {
        // Both end on 72x28 — the whole point is that the last-applied size is
        // identical and the histories are not.
        recordTerminalSize('t-hist-1', 72, 28);
        recordTerminalSize('t-hist-2', 72, 28);
        recordTerminalSize('t-hist-2', 103, 28);
        recordTerminalSize('t-hist-2', 72, 28);
        expect(getTerminalSize('t-hist-1')).toEqual(getTerminalSize('t-hist-2'));
        expect(getTerminalSizeHistory('t-hist-1')).toHaveLength(1);
        expect(getTerminalSizeHistory('t-hist-2')).toHaveLength(3);
    });

    it('timestamps each entry so a failure can say WHEN a forbidden resize landed', () => {
        recordTerminalSize('t-hist-1', 80, 24);
        const [entry] = getTerminalSizeHistory('t-hist-1');
        expect(entry).toBeDefined();
        expect(typeof entry.at).toBe('number');
        expect(entry.at).toBeGreaterThan(0);
    });

    it('never records a bogus grid, which the tracker itself refuses', () => {
        recordTerminalSize('t-hist-1', 0, -1);
        expect(getTerminalSizeHistory('t-hist-1')).toEqual([]);
    });

    it('forgets the history with the size, so a reused id starts clean', () => {
        recordTerminalSize('t-hist-1', 90, 30);
        forgetTerminalSize('t-hist-1');
        expect(getTerminalSizeHistory('t-hist-1')).toEqual([]);
    });

    it('is bounded, so a long session cannot grow one unboundedly', () => {
        for (let i = 1; i <= 400; i++) recordTerminalSize('t-hist-3', 80 + i, 24);
        const log = getTerminalSizeHistory('t-hist-3');
        expect(log.length).toBeLessThanOrEqual(200);
        // Bounded by DROPPING THE OLDEST: the recent resizes are the ones a
        // failure is about, so keeping the head instead would keep the useless half.
        expect(log[log.length - 1].cols).toBe(480);
    });

    it('records NOTHING outside the suite — and everything inside it (positive control)', () => {
        delete process.env.GENIE_E2E;
        recordTerminalSize('t-hist-1', 100, 40);
        expect(getTerminalSizeHistory('t-hist-1')).toEqual([]);
        // The control: the very same call DOES record once the flag is back, so
        // the emptiness above is the gate and not a broken recorder.
        process.env.GENIE_E2E = '1';
        recordTerminalSize('t-hist-1', 100, 40);
        expect(getTerminalSizeHistory('t-hist-1')).toHaveLength(1);
    });
});
