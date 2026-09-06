import { describe, expect, it } from 'vitest';
import {
    ASK_DRAWER_WIDTH,
    ASK_MODAL_WIDTH,
    askWindowBounds,
} from '../drawer-bounds';

/**
 * Where the ask window goes when the file drawer opens (Tynn story #272).
 *
 * The drawer sits BESIDE the question, not over it — the whole point is reading
 * the file the question is about without losing sight of the question — so the
 * frameless modal window has to grow to the right when it opens and shrink back
 * when it closes.
 *
 * Growing a window that is already near the right-hand edge of the screen pushes
 * half the drawer off it, where a frameless always-on-top window has no title bar
 * to drag it back by. That is the decision under test, and it is pure arithmetic,
 * so it is tested here rather than by opening a window on anybody's desktop.
 */

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };
const OPEN = ASK_MODAL_WIDTH + ASK_DRAWER_WIDTH;

describe('askWindowBounds', () => {
    it('is the bare modal width when the drawer is closed', () => {
        const b = askWindowBounds({
            current: { x: 680, y: 260, width: OPEN, height: 560 },
            workArea: SCREEN,
            drawerOpen: false,
        });
        expect(b.width).toBe(ASK_MODAL_WIDTH);
    });

    it('grows by exactly the drawer when it opens', () => {
        const b = askWindowBounds({
            current: { x: 680, y: 260, width: ASK_MODAL_WIDTH, height: 560 },
            workArea: SCREEN,
            drawerOpen: true,
        });
        expect(b.width).toBe(OPEN);
    });

    it('leaves the question where it is when the drawer has room', () => {
        const b = askWindowBounds({
            current: { x: 680, y: 260, width: ASK_MODAL_WIDTH, height: 560 },
            workArea: SCREEN,
            drawerOpen: true,
        });
        expect(b.x).toBe(680);
    });

    it('slides left rather than opening the drawer off the screen', () => {
        // A modal centred at the right edge: 1360 + 1080 would end at 2440.
        const b = askWindowBounds({
            current: { x: 1360, y: 260, width: ASK_MODAL_WIDTH, height: 560 },
            workArea: SCREEN,
            drawerOpen: true,
        });
        expect(b.x + b.width).toBe(SCREEN.x + SCREEN.width);
        expect(b.x).toBe(1920 - OPEN);
    });

    it('respects a work area that does not start at zero', () => {
        const b = askWindowBounds({
            current: { x: 2900, y: 300, width: ASK_MODAL_WIDTH, height: 560 },
            workArea: { x: 1920, y: 0, width: 1920, height: 1080 },
            drawerOpen: true,
        });
        expect(b.x).toBe(3840 - OPEN);
    });

    it('never grows wider than the screen it is on', () => {
        const workArea = { x: 0, y: 0, width: 900, height: 600 };
        const b = askWindowBounds({
            current: { x: 40, y: 20, width: ASK_MODAL_WIDTH, height: 560 },
            workArea,
            drawerOpen: true,
        });
        expect(b.width).toBe(900);
        expect(b.x).toBe(0);
    });

    it('pulls a window back on screen when the drawer closes', () => {
        const b = askWindowBounds({
            current: { x: -200, y: 260, width: OPEN, height: 560 },
            workArea: SCREEN,
            drawerOpen: false,
        });
        expect(b.x).toBe(0);
    });

    it('changes nothing about the height or the vertical position', () => {
        const b = askWindowBounds({
            current: { x: 680, y: 260, width: ASK_MODAL_WIDTH, height: 733 },
            workArea: SCREEN,
            drawerOpen: true,
        });
        expect(b.height).toBe(733);
        expect(b.y).toBe(260);
    });
});
