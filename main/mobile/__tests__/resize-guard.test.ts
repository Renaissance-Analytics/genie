import { afterEach, describe, expect, it } from 'vitest';
import { nextPtyGrid, _resetBridgeForTest } from '../terminal-bridge';

/**
 * The shared pty is owned by the desktop window; a phone in a narrow viewport
 * must never shrink it. `nextPtyGrid` enforces grow-only per terminal: it
 * returns the size to apply ONLY when a request would enlarge the pty beyond
 * anything the bridge has driven, and null otherwise (caller skips the resize,
 * leaving the desktop's size intact). Pure — driven directly.
 */

afterEach(() => _resetBridgeForTest());

describe('nextPtyGrid (grow-only pty guard)', () => {
    it('applies the first resize for a terminal (no floor yet)', () => {
        expect(nextPtyGrid('t1', 120, 40)).toEqual({ cols: 120, rows: 40 });
    });

    it('does NOT shrink the pty once a larger size was seen (the bug)', () => {
        nextPtyGrid('t1', 200, 50); // desktop-sized via the bridge
        // A narrow phone asks for 80×24 → would shrink → refused.
        expect(nextPtyGrid('t1', 80, 24)).toBeNull();
    });

    it('grows the pty when a request is strictly larger', () => {
        nextPtyGrid('t1', 100, 30);
        expect(nextPtyGrid('t1', 140, 40)).toEqual({ cols: 140, rows: 40 });
    });

    it('grows per-axis independently (taller-but-narrower keeps the wider cols)', () => {
        nextPtyGrid('t1', 200, 30);
        // More rows, fewer cols → cols held at 200, rows grow to 60.
        expect(nextPtyGrid('t1', 90, 60)).toEqual({ cols: 200, rows: 60 });
    });

    it('returns null when neither axis grows (same size)', () => {
        nextPtyGrid('t1', 120, 40);
        expect(nextPtyGrid('t1', 120, 40)).toBeNull();
    });

    it('tracks each terminal independently', () => {
        nextPtyGrid('t1', 200, 50);
        // A fresh terminal starts with no floor.
        expect(nextPtyGrid('t2', 80, 24)).toEqual({ cols: 80, rows: 24 });
        // t1 still refuses a shrink.
        expect(nextPtyGrid('t1', 80, 24)).toBeNull();
    });

    it('rejects non-finite / non-positive dimensions', () => {
        expect(nextPtyGrid('t1', Number.NaN, 40)).toBeNull();
        expect(nextPtyGrid('t1', 120, Number.POSITIVE_INFINITY)).toBeNull();
        expect(nextPtyGrid('t1', 0, 40)).toBeNull();
        expect(nextPtyGrid('t1', 120, -5)).toBeNull();
    });

    it('resets the floor after the bridge is reset (e.g. pty exit / test reset)', () => {
        nextPtyGrid('t1', 200, 50);
        _resetBridgeForTest();
        // Floor cleared → the next size is accepted as-is.
        expect(nextPtyGrid('t1', 80, 24)).toEqual({ cols: 80, rows: 24 });
    });
});
