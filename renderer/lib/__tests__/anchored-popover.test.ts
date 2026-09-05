import { describe, expect, it } from 'vitest';
import {
    anchoredPopoverPosition,
    anchoredPopoverTop,
    clampPopoverAxis,
    clampPopoverToViewport,
} from '../anchored-popover';

describe('anchoredPopoverTop', () => {
    it('opens below the anchor when the popover fits', () => {
        expect(
            anchoredPopoverTop({
                anchorTop: 100,
                anchorBottom: 132,
                popoverHeight: 200,
                viewportHeight: 600,
            }),
        ).toBe(138);
    });

    it('flips above the anchor instead of clipping at the bottom', () => {
        expect(
            anchoredPopoverTop({
                anchorTop: 500,
                anchorBottom: 532,
                popoverHeight: 280,
                viewportHeight: 600,
            }),
        ).toBe(214);
    });

    it('keeps an oversized popover pinned to the viewport margin', () => {
        expect(
            anchoredPopoverTop({
                anchorTop: 40,
                anchorBottom: 72,
                popoverHeight: 700,
                viewportHeight: 600,
            }),
        ).toBe(8);
    });
});

describe('clampPopoverAxis', () => {
    it('leaves a span that already fits where it is', () => {
        expect(clampPopoverAxis({ start: 100, size: 268, viewport: 1200 })).toBe(100);
    });

    it('pulls a span back inside the far edge', () => {
        expect(clampPopoverAxis({ start: 1100, size: 268, viewport: 1200 })).toBe(924);
    });

    it('never pushes the near edge off screen, even when the span cannot fit', () => {
        // A popover wider than the viewport: pinning to `viewport - size - margin`
        // alone would go NEGATIVE and put the readable edge off screen.
        expect(clampPopoverAxis({ start: 40, size: 400, viewport: 200 })).toBe(8);
    });
});

/**
 * The bug in genie#416, as a fixture: a LOW anchor in a SHORT viewport.
 *
 * The positive control matters more than the assertion here. `top` was
 * `anchorBottom + gap` with no viewport check, which is correct on any viewport
 * tall enough — which is every developer's. So the first expectation pins that
 * this fixture genuinely overflows, and only then that the helper does not.
 */
describe('anchoredPopoverPosition clamps BOTH axes', () => {
    const anchor = { top: 540, right: 300, bottom: 560, left: 288 };
    const size = { popoverWidth: 268, popoverHeight: 220 };
    const viewport = { viewportWidth: 1200, viewportHeight: 600 };

    it('POSITIVE CONTROL: the unclamped placement really does run off the bottom', () => {
        const unclamped = anchor.bottom + 6;
        expect(unclamped + size.popoverHeight).toBeGreaterThan(viewport.viewportHeight);
    });

    it('flips the popover above a low anchor instead of running off the bottom', () => {
        const { top } = anchoredPopoverPosition({ anchor, ...size, ...viewport });
        expect(top + size.popoverHeight).toBeLessThanOrEqual(viewport.viewportHeight);
        expect(top).toBe(314);
    });

    it('still clamps horizontally — the axis that already worked', () => {
        const nearRightEdge = { top: 100, right: 1198, bottom: 120, left: 1180 };
        const { left } = anchoredPopoverPosition({
            anchor: nearRightEdge,
            ...size,
            ...viewport,
            align: 'end',
        });
        expect(left + size.popoverWidth).toBeLessThanOrEqual(viewport.viewportWidth);
    });

    it('aligns the popover to the anchor edge the caller asks for', () => {
        const roomy = { top: 100, right: 600, bottom: 120, left: 500 };
        expect(anchoredPopoverPosition({ anchor: roomy, ...size, ...viewport, align: 'start' }).left).toBe(500);
        expect(anchoredPopoverPosition({ anchor: roomy, ...size, ...viewport, align: 'end' }).left).toBe(332);
    });
});

/**
 * The point-anchored form — a right-click menu, or a popover opened beside a
 * row. Same clamp, no flip: a menu that jumped ABOVE the cursor would put a
 * different item under the pointer than the one the user aimed at.
 */
describe('clampPopoverToViewport', () => {
    it('POSITIVE CONTROL: the unclamped point really does overflow both axes', () => {
        expect(1150 + 200).toBeGreaterThan(1200);
        expect(560 + 240).toBeGreaterThan(600);
    });

    it('pulls a menu opened near the corner back inside both edges', () => {
        expect(
            clampPopoverToViewport({
                left: 1150,
                top: 560,
                width: 200,
                height: 240,
                viewportWidth: 1200,
                viewportHeight: 600,
            }),
        ).toEqual({ left: 992, top: 352 });
    });

    it('leaves a menu with room where it was opened', () => {
        expect(
            clampPopoverToViewport({
                left: 300,
                top: 200,
                width: 200,
                height: 240,
                viewportWidth: 1200,
                viewportHeight: 600,
            }),
        ).toEqual({ left: 300, top: 200 });
    });
});
