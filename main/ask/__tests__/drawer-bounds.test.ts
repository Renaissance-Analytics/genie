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

/**
 * An x with genuine room for the drawer, DERIVED from the widths rather than
 * written as a number.
 *
 * A hardcoded 680 used to satisfy "has room" and stopped doing so the moment the
 * modal got wider (genie#458) — at which point the test failed for a reason that
 * had nothing to do with the rule it was guarding. The premise is now computed,
 * so it stays true whatever the widths become.
 */
const ROOMY_X = SCREEN.width - OPEN - 40;

/**
 * The window is centred on its display — asserted as a PROPERTY (the gap on the
 * left matches the gap on the right) rather than by recomputing the formula the
 * implementation uses, which would only prove the test can do the same
 * arithmetic as the code. Tolerates a pixel, because an odd leftover cannot be
 * split evenly.
 */
function expectCentred(
    b: { x: number; width: number },
    area: { x: number; width: number },
): void {
    const left = b.x - area.x;
    const right = area.x + area.width - (b.x + b.width);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    // Centred is only meaningful if it is also ON the display.
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(0);
}

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

    it('RECENTRES on the display when the drawer opens (genie#475)', () => {
        // The premise, asserted rather than assumed: there was room to grow in
        // place, so recentring is a choice here and not the clamp in disguise.
        expect(ROOMY_X + OPEN).toBeLessThanOrEqual(SCREEN.x + SCREEN.width);

        const b = askWindowBounds({
            current: { x: ROOMY_X, y: 260, width: ASK_MODAL_WIDTH, height: 560 },
            workArea: SCREEN,
            drawerOpen: true,
        });
        // It used to keep `x` and grow rightward from wherever it happened to
        // be, which left a modal near an edge visibly lopsided.
        expect(b.x).not.toBe(ROOMY_X);
        expectCentred(b, SCREEN);
    });

    it('recentres when the drawer CLOSES too, so it never ends up lopsided', () => {
        // Recentring only on the way out would trade one lopsided window for
        // another: the width shrinks by the drawer while `x` stays, leaving the
        // question sitting half a drawer left of centre.
        const opened = askWindowBounds({
            current: { x: ROOMY_X, y: 260, width: ASK_MODAL_WIDTH, height: 560 },
            workArea: SCREEN,
            drawerOpen: true,
        });
        const closed = askWindowBounds({
            current: opened,
            workArea: SCREEN,
            drawerOpen: false,
        });
        expect(closed.width).toBe(ASK_MODAL_WIDTH);
        expectCentred(closed, SCREEN);
    });

    it('brings a modal at the right-hand edge fully back on screen', () => {
        // The original defect: growing in place from here ran the drawer off the
        // display, and a frameless always-on-top window has no title bar to drag
        // it back by. Recentring subsumes the old slide-left clamp.
        const b = askWindowBounds({
            current: { x: SCREEN.width - ASK_MODAL_WIDTH, y: 260, width: ASK_MODAL_WIDTH, height: 560 },
            workArea: SCREEN,
            drawerOpen: true,
        });
        expect(b.x + b.width).toBeLessThanOrEqual(SCREEN.x + SCREEN.width);
        expectCentred(b, SCREEN);
    });

    it('centres on the display it is on, not on the primary one', () => {
        const workArea = { x: 1920, y: 0, width: 1920, height: 1080 };
        const b = askWindowBounds({
            current: { x: 2900, y: 300, width: ASK_MODAL_WIDTH, height: 560 },
            workArea,
            drawerOpen: true,
        });
        // A second monitor starts at 1920, so a window centred on the PRIMARY
        // display would be off this one entirely.
        expect(b.x).toBeGreaterThanOrEqual(workArea.x);
        expectCentred(b, workArea);
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
        expect(b.x).toBeGreaterThanOrEqual(SCREEN.x);
        expectCentred(b, SCREEN);
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
