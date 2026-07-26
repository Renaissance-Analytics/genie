import { describe, expect, it } from 'vitest';
import { clampWandX, sameAnchor } from '../wand-anchor';

/**
 * Simulate a rendered pill: its edges track `x` rigidly (the pill is
 * `position: fixed; left: x` under a `translate(-50%)`), so a correction to
 * `x` moves both edges by the same delta.
 */
function edges(x: number, width: number) {
    return { left: x - width / 2, right: x + width / 2 };
}

/** Apply clampWandX until it reports "no change", capping the passes. */
function settle(x: number, width: number, viewportWidth: number, cap = 50) {
    let cur = x;
    let passes = 0;
    for (; passes < cap; passes++) {
        const next = clampWandX({ ...edges(cur, width), x: cur, viewportWidth });
        if (next === null) return { x: cur, passes };
        cur = next;
    }
    return { x: cur, passes };
}

describe('sameAnchor', () => {
    it('treats the identical anchor as unchanged', () => {
        const a = { x: 10, y: 20 };
        expect(sameAnchor(a, a)).toBe(true);
        expect(sameAnchor({ x: 10, y: 20 }, { x: 10, y: 20 })).toBe(true);
    });

    it('treats two absent anchors as unchanged, and appear/disappear as changed', () => {
        expect(sameAnchor(null, null)).toBe(true);
        expect(sameAnchor(null, { x: 1, y: 2 })).toBe(false);
        expect(sameAnchor({ x: 1, y: 2 }, null)).toBe(false);
    });

    it('ignores sub-pixel jitter but reports a real move', () => {
        expect(sameAnchor({ x: 10, y: 20 }, { x: 10.2, y: 20.1 })).toBe(true);
        expect(sameAnchor({ x: 10, y: 20 }, { x: 11, y: 20 })).toBe(false);
        expect(sameAnchor({ x: 10, y: 20 }, { x: 10, y: 21 })).toBe(false);
    });
});

describe('clampWandX', () => {
    it('leaves a pill that already fits alone', () => {
        expect(
            clampWandX({ x: 600, left: 500, right: 700, viewportWidth: 1280 }),
        ).toBeNull();
    });

    it('pushes a pill clipped at the left edge back to the margin', () => {
        // 180-wide pill centred on x=40 → left edge at -50.
        expect(clampWandX({ x: 40, left: -50, right: 130, viewportWidth: 1280 })).toBe(96);
    });

    it('pulls a pill clipped at the right edge back to the margin', () => {
        // 180-wide pill centred on x=1250 → right edge at 1340, limit 1274.
        expect(
            clampWandX({ x: 1250, left: 1160, right: 1340, viewportWidth: 1280 }),
        ).toBe(1184);
    });

    it('settles in a single correction at either edge', () => {
        expect(settle(40, 180, 1280).passes).toBe(1);
        expect(settle(1250, 180, 1280).passes).toBe(1);
        expect(settle(600, 180, 1280).passes).toBe(0);
    });

    it('pins an over-wide pill to the left margin instead of oscillating', () => {
        // The pill cannot satisfy both margins at once. Alternating between them
        // is an unbounded setState-in-layout-effect loop (React #185), so the
        // left edge wins and the correction is a FIXED POINT.
        const width = 400;
        const viewportWidth = 300;
        const settled = settle(150, width, viewportWidth);
        expect(settled.passes).toBeLessThanOrEqual(1);
        expect(clampWandX({ ...edges(settled.x, width), x: settled.x, viewportWidth })).toBeNull();
        expect(edges(settled.x, width).left).toBe(6);
    });

    it('is a fixed point for every starting position', () => {
        for (let x = -500; x <= 1800; x += 7) {
            const settled = settle(x, 180, 1280);
            expect(settled.passes).toBeLessThanOrEqual(1);
            expect(
                clampWandX({ ...edges(settled.x, 180), x: settled.x, viewportWidth: 1280 }),
            ).toBeNull();
        }
    });
});
