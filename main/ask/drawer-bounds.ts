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
    /** The width to widen FROM — the size the user chose, when they have chosen
     *  one (genie#703). Defaults to the stock modal width, which is what every
     *  caller meant before the window could be resized. Without it, closing the
     *  drawer would snap a widened window back to 760 and silently discard the
     *  size Genie had just promised to remember. */
    baseWidth?: number;
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
    baseWidth = ASK_MODAL_WIDTH,
}: AskWindowBoundsInput): AskWindowGeometry {
    const wanted = drawerOpen ? baseWidth + ASK_DRAWER_WIDTH : baseWidth;
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

export interface AskWindowFitInput {
    /** Where the window is now — whatever the window manager made of it. */
    current: AskWindowGeometry;
    /** The display's usable area (Electron's `screen` work area). */
    workArea: { x: number; y: number; width: number; height: number };
}

/**
 * The bounds that put the whole window on the display (genie#703).
 *
 * `createAskWindow` asks for a fixed height and `resizable: false`; a tiling
 * window manager honours neither. On the reported machine the modal ended up
 * taller than the screen with its bottom — and therefore its Cancel/Submit row —
 * past the edge, which reads exactly like a clipped footer and is not one. No
 * stylesheet can pull a window back onto a display, which is why the first fix
 * attempted for this (a flex `min-height`) changed nothing.
 *
 * SHRINK ONLY WHEN THE DISPLAY CANNOT AFFORD THE SIZE. A window that fits but
 * hangs off the edge is MOVED: taking height the screen could have given is a
 * second, unasked-for change to a window someone is already reading.
 *
 * Separate from {@link askWindowBounds} on purpose — that one answers "how wide
 * for this drawer state" and deliberately never touches the vertical axis, so
 * folding a display clamp into it would make every drawer toggle reposition the
 * window too.
 */
export function askWindowFit({ current, workArea }: AskWindowFitInput): AskWindowGeometry {
    const height = Math.min(current.height, workArea.height);
    const width = Math.min(current.width, workArea.width);
    // `max` last, so a work area reported as zero (or smaller than the window)
    // still pins the top-left on screen instead of producing a window nobody can
    // reach — the same fallback the horizontal clamp above keeps.
    const y = Math.max(workArea.y, Math.min(current.y, workArea.y + workArea.height - height));
    const x = Math.max(workArea.x, Math.min(current.x, workArea.x + workArea.width - width));
    return { x, y, width, height };
}

/** The height the modal has always opened at. Paired with {@link ASK_MODAL_WIDTH}
 *  as the default size, which the owner asked to keep unchanged when the window
 *  became resizable (genie#703). */
export const ASK_MODAL_HEIGHT = 560;
/** Below this, the question is unanswerable — the action row and the option list
 *  stop fitting — so a smaller remembered size is refused rather than restored. */
export const ASK_MODAL_MIN_WIDTH = 480;
export const ASK_MODAL_MIN_HEIGHT = 320;

/**
 * A remembered modal size, or null when there is nothing usable to restore.
 *
 * Stored as a CLIENT setting (owner): in a remote window the size belongs to the
 * machine showing the question, not the host that asked it — so it is not in
 * `HOST_SOURCED_SETTINGS_KEYS` and each client keeps its own.
 *
 * Refuses anything unusable rather than storing it: a window remembered at 12x8
 * is a window nobody can answer a question in, and it would come back that way
 * on every question until someone found the setting.
 */
export function parseAskModalSize(raw: string | null | undefined): AskModalSize | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const { width, height } = parsed as { width?: unknown; height?: unknown };
        if (typeof width !== 'number' || typeof height !== 'number') return null;
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
        if (width < ASK_MODAL_MIN_WIDTH || height < ASK_MODAL_MIN_HEIGHT) return null;
        return { width: Math.round(width), height: Math.round(height) };
    } catch {
        return null;
    }
}

export interface AskModalSize {
    width: number;
    height: number;
}

/** The size to open at: the remembered one, or the size the modal has always
 *  had. The default is deliberately unchanged (owner) — making the window
 *  resizable must not also change what it looks like on first open. */
export function askModalStartSize(saved: AskModalSize | null): AskModalSize {
    return saved ?? { width: ASK_MODAL_WIDTH, height: ASK_MODAL_HEIGHT };
}
