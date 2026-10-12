/**
 * THE MAIN WINDOW'S FRAME — pure, so a test can hold it.
 *
 * The board's chrome is Genie's own 36 px bar, so the OS title bar is hidden. On the owner's first
 * real run of 2.0.0-beta.5 (2026-10-11) that hidden bar came with NO drag region, NO window
 * buttons and NO minimum size: the window could not be moved, resized or closed. Three facts
 * that no script-driven window check ever notices, because a script never drags.
 *
 * - `titleBarStyle: 'hidden'` on every platform (the chrome owns the top).
 * - On Windows and Linux, `titleBarOverlay` keeps the native minimize / maximize / close cluster
 *   drawn OVER our bar at the right, 36 px tall, in the bar's colours; macOS keeps its inset
 *   traffic lights and needs no overlay.
 * - The bar itself is the drag region (`-webkit-app-region: drag` in TitleBar), with every
 *   control inside it opted out.
 * - A minimum size the board was designed for, so a resize cannot fold the rail under the table.
 */
export const TITLE_BAR_HEIGHT = 36;

export interface MainWindowOptions {
    readonly width: number;
    readonly height: number;
    readonly minWidth: number;
    readonly minHeight: number;
    readonly titleBarStyle: 'hidden';
    readonly titleBarOverlay?: { readonly height: number; readonly color: string; readonly symbolColor: string };
}

export function mainWindowOptions(platform: NodeJS.Platform): MainWindowOptions {
    const base = { width: 1440, height: 900, minWidth: 980, minHeight: 620, titleBarStyle: 'hidden' as const };
    if (platform === 'darwin') return base;
    return { ...base, titleBarOverlay: { height: TITLE_BAR_HEIGHT, color: '#0a0a0c', symbolColor: '#e4e4e7' } };
}
