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
 * to drag it back by. So the width is clamped to the display, and the window is
 * RECENTRED on it.
 *
 * Recentring replaced a keep-`x`-and-slide-left-if-it-must clamp (genie#475).
 * That clamp only moved the window when it was about to run off the edge, so the
 * window grew rightward from wherever it happened to be: a modal near the left
 * edge finished visibly lopsided, and one near the right finished pinned flush
 * against it. Centring is the rule the clamp was approximating, and it subsumes
 * it — a centred window is on the display by construction.
 *
 * It applies in BOTH directions, which is the part worth stating. Recentring
 * only on open would trade one lopsided window for another: the width would
 * shrink by the drawer on close while `x` stayed, leaving the question sitting
 * half a drawer left of centre. So the rule is simply "centred for whatever
 * width it currently has".
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
export const ASK_MODAL_WIDTH = 760;
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
 * unasked-for change to a window the user is reading. `current.x` is likewise no
 * longer read — the horizontal position is now derived entirely from the display
 * and the target width.
 */
export function askWindowBounds({
    current,
    workArea,
    drawerOpen,
}: AskWindowBoundsInput): AskWindowGeometry {
    const wanted = drawerOpen ? ASK_MODAL_WIDTH + ASK_DRAWER_WIDTH : ASK_MODAL_WIDTH;
    const width = Math.min(wanted, workArea.width);
    // Centred on the display the window is on — `workArea.x` is not zero on a
    // second monitor, and centring on the primary one would put the window off
    // this display entirely.
    const centred = workArea.x + Math.round((workArea.width - width) / 2);
    const maxX = workArea.x + workArea.width - width;
    // The clamp is kept as the fallback the centring cannot need but must not do
    // without: `width` is already capped at the work area, so `centred` sits
    // inside [workArea.x, maxX] for every sane display — and a work area
    // reported as zero-width or negative should still pin the left edge on
    // screen rather than produce a window nobody can reach.
    const x = Math.max(workArea.x, Math.min(centred, maxX));
    return { x, y: current.y, width, height: current.height };
}
