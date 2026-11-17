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

/** STUB (Tynn #739 RED): the work area's corner, at the browser's own size. */
export function browserWindowBounds(input: PlacementInput): Rect {
    return { x: input.workArea.x, y: input.workArea.y, width: input.size.width, height: input.size.height };
}

export interface MoveInput extends PlacementInput {
    readonly activation: 'user-gesture' | 'background';
    /** The open window is on the anchor's display already. */
    readonly onAnchorDisplay: boolean;
}

/** STUB (Tynn #739 RED): never moved. */
export function browserWindowMove(_input: MoveInput): Rect | null {
    return null;
}
