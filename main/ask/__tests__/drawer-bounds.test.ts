import { describe, expect, it } from 'vitest';
import {
    ASK_DRAWER_WIDTH,
    ASK_MODAL_WIDTH,
    askWindowBounds, askWindowFit, parseAskModalSize, askModalStartSize } from '../drawer-bounds';

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

/**
 * THE WINDOW HAS TO BE ON THE SCREEN (genie#703).
 *
 * Reported on Omarchy (Hyprland): the question modal rendered with its action
 * row — Cancel and Submit — nowhere to be found, and the screenshot shows the
 * window's left, top and right borders but NO bottom one. The window is not
 * clipping its footer; the window runs off the bottom of the display.
 *
 * `createAskWindow` asks for 560px tall and `resizable: false`. A tiling WM does
 * not honour either, and nothing in Genie ever checked the result against the
 * display: `askWindowBounds` deliberately leaves the vertical axis alone (the
 * drawer only changes width), and no other path looks at it.
 *
 * No stylesheet can rescue a window whose bottom edge is past the screen, which
 * is why the first attempt at this — `min-height: 0` on the scroll region — was
 * a no-op: the layout was never the problem.
 */
describe('askWindowFit — the modal is pulled back onto the display', () => {
    const workArea = { x: 0, y: 0, width: 1280, height: 800 };

    it('shrinks a window taller than the display, so its footer is on screen', () => {
        // The reported shape: a WM handed the modal more height than the screen.
        const fitted = askWindowFit({
            current: { x: 100, y: 0, width: 760, height: 1000 },
            workArea,
        });
        expect(fitted.height).toBe(800);
        expect(fitted.y + fitted.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    });

    it('MOVES a window that fits but hangs off the bottom, rather than shrinking it', () => {
        // Losing height that the display can afford would be a second, unasked
        // change to a window someone is reading.
        const fitted = askWindowFit({
            current: { x: 100, y: 600, width: 760, height: 560 },
            workArea,
        });
        expect(fitted.height).toBe(560);
        expect(fitted.y).toBe(240);
    });

    it('leaves a window that already fits exactly as it is', () => {
        // POSITIVE CONTROL: every ordinary show must be a no-op, or this becomes
        // a window that jumps on each question.
        const current = { x: 260, y: 120, width: 760, height: 560 };
        expect(askWindowFit({ current, workArea })).toEqual(current);
    });

    it('respects a second monitor: the work area is not at the origin', () => {
        // `workArea.x/y` are non-zero on a second display, and clamping against
        // 0 would throw the window onto the primary one.
        const second = { x: 1280, y: 40, width: 1024, height: 768 };
        const fitted = askWindowFit({
            current: { x: 1300, y: 700, width: 760, height: 560 },
            workArea: second,
        });
        expect(fitted.y).toBe(second.y + second.height - 560);
        expect(fitted.x).toBeGreaterThanOrEqual(second.x);
    });

    it('pins the top-left on screen when the display reports nothing usable', () => {
        // A work area of zero is not a reason to produce a window nobody can
        // reach — the same fallback the horizontal clamp already keeps.
        const fitted = askWindowFit({
            current: { x: -500, y: -500, width: 760, height: 560 },
            workArea: { x: 0, y: 0, width: 0, height: 0 },
        });
        expect(fitted.x).toBe(0);
        expect(fitted.y).toBe(0);
    });
});

/**
 * THE USER CAN RESIZE THE MODAL, AND IT REMEMBERS (genie#703, owner).
 *
 * The window was deliberately fixed-size — "nothing about a question wants a
 * drag handle" — and that is exactly why a window a tiling WM had mangled could
 * not be rescued by hand. The owner's call: make it resizable, "make sure that
 * size is default what it is now and the setting is a client setting."
 *
 * So the DEFAULT is unchanged (760x560, what it has always opened at), a size
 * the user chose is remembered, and anything unusable is refused rather than
 * stored — a window remembered at 12x8 is a window nobody can answer.
 */
describe('parseAskModalSize — a remembered size is only honoured if it is usable', () => {
    it('reads back a size the user chose', () => {
        expect(parseAskModalSize('{"width":900,"height":700}')).toEqual({
            width: 900,
            height: 700,
        });
    });

    it('refuses a size too small to answer a question in', () => {
        expect(parseAskModalSize('{"width":40,"height":20}')).toBeNull();
    });

    it('refuses junk, a missing value, and the wrong types', () => {
        expect(parseAskModalSize(undefined)).toBeNull();
        expect(parseAskModalSize('')).toBeNull();
        expect(parseAskModalSize('not json')).toBeNull();
        expect(parseAskModalSize('{"width":"900","height":700}')).toBeNull();
        expect(parseAskModalSize('{"width":null,"height":null}')).toBeNull();
    });

    it('falls back to the size the modal has always opened at', () => {
        // The owner's requirement, pinned: no remembered size means 760x560.
        expect(askModalStartSize(null)).toEqual({ width: ASK_MODAL_WIDTH, height: 560 });
        expect(askModalStartSize(parseAskModalSize('garbage'))).toEqual({
            width: ASK_MODAL_WIDTH,
            height: 560,
        });
    });
});

describe('askWindowBounds — the drawer widens from the size the USER chose', () => {
    const workArea = { x: 0, y: 0, width: 2560, height: 1400 };

    it('adds the drawer to a remembered width, and gives it back on close', () => {
        // Without this, opening a file and closing it again would snap a window
        // the user had widened back to the stock 760 — silently discarding the
        // size we just promised to remember.
        const current = { x: 0, y: 0, width: 900, height: 700 };
        const open = askWindowBounds({ current, workArea, drawerOpen: true, baseWidth: 900 });
        expect(open.width).toBe(900 + ASK_DRAWER_WIDTH);

        const closed = askWindowBounds({ current: open, workArea, drawerOpen: false, baseWidth: 900 });
        expect(closed.width).toBe(900);
    });

    it('still uses the stock width when no size was remembered', () => {
        // POSITIVE CONTROL: the default path is untouched by the new parameter.
        const current = { x: 0, y: 0, width: ASK_MODAL_WIDTH, height: 560 };
        expect(askWindowBounds({ current, workArea, drawerOpen: false }).width).toBe(
            ASK_MODAL_WIDTH,
        );
    });
});
