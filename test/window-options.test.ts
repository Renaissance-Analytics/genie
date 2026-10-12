import { describe, expect, it } from 'vitest';
import { mainWindowOptions, TITLE_BAR_HEIGHT } from '../src/core/window.js';

/**
 * THE WINDOW CAN BE MOVED, RESIZED AND CLOSED. On the owner's first real run of 2.0.0-beta.5 it
 * could be none of those: a hidden title bar with no overlay (no window buttons), no minimum size,
 * and a bar that was not a drag region. These hold the frame; `title-bar-drag.test.tsx` holds the bar.
 */
describe('mainWindowOptions', () => {
    it('Windows and Linux keep the native minimize / maximize / close cluster as an overlay the height of our bar', () => {
        for (const platform of ['win32', 'linux'] as const) {
            const o = mainWindowOptions(platform);
            expect(o.titleBarStyle).toBe('hidden');
            expect(o.titleBarOverlay).toEqual({ height: TITLE_BAR_HEIGHT, color: '#0a0a0c', symbolColor: '#e4e4e7' });
            expect(TITLE_BAR_HEIGHT).toBe(36);
        }
    });

    it('macOS keeps its inset traffic lights and needs no overlay', () => {
        const o = mainWindowOptions('darwin');
        expect(o.titleBarStyle).toBe('hidden');
        expect(o.titleBarOverlay).toBeUndefined();
    });

    it('has a minimum size the board was designed for, below the default size', () => {
        const o = mainWindowOptions('win32');
        expect(o.minWidth).toBeGreaterThanOrEqual(900);
        expect(o.minHeight).toBeGreaterThanOrEqual(600);
        expect(o.width).toBeGreaterThan(o.minWidth);
        expect(o.height).toBeGreaterThan(o.minHeight);
    });
});
