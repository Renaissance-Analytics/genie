import { describe, expect, it } from 'vitest';
import { anchoredPopoverTop } from '../anchored-popover';

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
