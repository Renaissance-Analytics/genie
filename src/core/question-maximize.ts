import { askWindowBounds, type AskWindowGeometry } from './question-drawer.js';

/**
 * THE WHOLE QUESTION WINDOW CAN BE MAXIMIZED (Tynn #1019; the owner, 2026-11-21: "make sure that FTQ windows can be
 * maximized, not just image previews in it"). The pure half: where the window goes, and where it comes back to.
 *
 * The window is frameless and `maximizable: false` (main/question-window-electron.ts), so the OS maximize is not used: it
 * would be refused on some platforms, and on others it would give the window a maximized state the OS then owns (a snap
 * on drag, a different restore). Main sets its bounds instead: the WORK AREA of the display it is on, so it never sits
 * under a taskbar and never moves to another monitor; and back to the bounds it had, which main keeps while it is
 * maximized.
 *
 * The file drawer (core/question-drawer.ts) may open or close while the window is maximized. A maximized window already
 * has the room, so main does not resize it then; Restore then puts back the saved bounds AS THE DRAWER IS NOW: widened
 * from them (centred, as the drawer always is) if it opened, back to its width before the drawer if it closed.
 */
export function askWindowMaximized(workArea: AskWindowGeometry): AskWindowGeometry {
    return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
}

export interface AskWindowRestoreInput {
    /** The bounds the window had when it was maximized. */
    saved: AskWindowGeometry;
    /** The work area of the display it is on now. */
    workArea: AskWindowGeometry;
    /** Is the drawer open now, and was it when the window was maximized? */
    drawerOpen: boolean;
    drawerOpenWhenSaved: boolean;
    /** The width the window had before the drawer widened it (main's `baseWidth`), or null with no drawer open. */
    baseWidth: number | null;
}

/** The bounds to restore to, and main's `baseWidth` after it. Always on the display. */
export function askWindowRestored({ saved, workArea, drawerOpen, drawerOpenWhenSaved, baseWidth }: AskWindowRestoreInput): { bounds: AskWindowGeometry; baseWidth: number | null } {
    let bounds = saved;
    let base = baseWidth;
    if (drawerOpen && !drawerOpenWhenSaved) {
        base = saved.width;
        bounds = askWindowBounds({ current: saved, workArea, drawerOpen: true, baseWidth: base });
    } else if (!drawerOpen && drawerOpenWhenSaved) {
        bounds = askWindowBounds({ current: saved, workArea, drawerOpen: false, baseWidth: baseWidth ?? saved.width });
        base = null;
    }
    const width = Math.min(bounds.width, workArea.width);
    const height = Math.min(bounds.height, workArea.height);
    const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height));
    return { bounds: { x, y, width, height }, baseWidth: base };
}
