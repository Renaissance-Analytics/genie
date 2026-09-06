/**
 * Where the ask window goes when the file drawer opens (Tynn story #272).
 *
 * The drawer sits BESIDE the question, not over it — the point of it is reading
 * the file a question is about WITHOUT losing sight of the question — so the
 * frameless modal grows to the right when it opens and shrinks back when it
 * closes.
 *
 * Growing a window that already sits near the right-hand edge of the screen puts
 * half the drawer past it, and a frameless always-on-top window has no title bar
 * to drag it back by. So the width is clamped to the display and the window
 * slides left to fit, rather than growing off the edge.
 *
 * Pure arithmetic, kept out of `force-question.ts` so it can be tested without
 * opening a window on anybody's desktop.
 */

export interface AskWindowGeometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The question column — the modal's width with no drawer. */
export const ASK_MODAL_WIDTH = 560;
/** How much wider the window gets when the file drawer opens. */
export const ASK_DRAWER_WIDTH = 520;

export interface AskWindowBoundsInput {
    /** Where the window is now. */
    current: AskWindowGeometry;
    /** The display's usable area (Electron's `screen` work area). */
    workArea: { x: number; y: number; width: number; height: number };
    drawerOpen: boolean;
}

/**
 * The bounds the ask window should have for the requested drawer state.
 *
 * Vertical position and height are never touched: the drawer changes how WIDE
 * the window is, and moving it up or down as a side effect would be a second,
 * unasked-for change to a window the user is reading.
 */
export function askWindowBounds({
    current,
    workArea,
    drawerOpen,
}: AskWindowBoundsInput): AskWindowGeometry {
    const wanted = drawerOpen ? ASK_MODAL_WIDTH + ASK_DRAWER_WIDTH : ASK_MODAL_WIDTH;
    const width = Math.min(wanted, workArea.width);
    const maxX = workArea.x + workArea.width - width;
    // `Math.max` runs last so a work area NARROWER than the window still pins the
    // left edge on screen rather than pushing it off the other side.
    const x = Math.max(workArea.x, Math.min(current.x, maxX));
    return { x, y: current.y, width, height: current.height };
}
