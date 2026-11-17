/**
 * WHERE THE GENIE BROWSER WINDOW OPENS (Tynn #739; LiftPoint onboarding, 2026-11-16, transcript 00:30:49): the owner,
 * driving remotely, had to go looking for it ("It doesn't like pop open automatically"), and on the client's laptop it
 * "popped open on another screen". Pure: Electron's displays are read by the caller (genie-browser-electron.ts).
 */

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface PlacementInput {
    /** The Genie window that asked (the rail's Browser, a site row's Open); null: nothing asked, an agent's open. */
    readonly anchor: Rect | null;
    /** The work area of the display the anchor is mostly on (else the display under the cursor). */
    readonly workArea: Rect;
    /** The browser window's own size (core/window.ts browserWindowOptions). */
    readonly size: { readonly width: number; readonly height: number };
}

/**
 * A fresh browser window's bounds: its own size, cut to the work area (a 1366 x 768 laptop's is ~728 tall, and a window
 * taller than it opened with its bottom off the screen); centred over the window that asked (else over the work area);
 * then kept inside the work area. `workArea.x`/`y` are not zero on a second display, and may be negative.
 */
export function browserWindowBounds(input: PlacementInput): Rect {
    const { workArea: wa, anchor } = input;
    const width = Math.min(input.size.width, wa.width);
    const height = Math.min(input.size.height, wa.height);
    const around = anchor ?? wa;
    const cx = around.x + around.width / 2;
    const cy = around.y + around.height / 2;
    const x = Math.max(wa.x, Math.min(Math.round(cx - width / 2), wa.x + wa.width - width));
    const y = Math.max(wa.y, Math.min(Math.round(cy - height / 2), wa.y + wa.height - height));
    return { x, y, width, height };
}

export interface MoveInput extends PlacementInput {
    readonly activation: 'user-gesture' | 'background';
    /** The open window is on the anchor's display already. */
    readonly onAnchorDisplay: boolean;
}

/**
 * An OPEN browser window and a new ask: the person's click from a Genie window on ANOTHER display brings the browser to
 * that display, placed as a fresh one. On the same display it stays where the person put it, and an agent's open
 * (background) never moves it.
 */
export function browserWindowMove(input: MoveInput): Rect | null {
    if (input.activation !== 'user-gesture' || input.anchor === null || input.onAnchorDisplay) return null;
    return browserWindowBounds(input);
}
