import { describe, expect, it } from 'vitest';
import { isUsableGrid, recordTerminalSize, getTerminalSize, forgetTerminalSize } from '../size-tracker';

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
