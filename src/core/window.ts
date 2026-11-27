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

/**
 * THE SPACE THE NATIVE BUTTONS TAKE, measured (the owner, 2026-10-13: "content covered"). The bar used
 * `env(titlebar-area-width)`, which resolved to nothing in a real window, so the workstation chip slid under the
 * buttons. The renderer reads Electron's `navigator.windowControlsOverlay` title-bar area instead: the inset is the
 * viewport width less that area's right edge. A window that HAS the overlay but cannot measure it keeps the Windows
 * caption cluster's width (three 46 px buttons) clear; a window without one keeps nothing.
 */
export const CONTROLS_FALLBACK_INSET = 3 * 46;

export function controlsInset(area: { x: number; width: number } | null, viewportWidth: number, hasOverlay: boolean): number {
    if (!hasOverlay) return 0;
    if (area === null) return CONTROLS_FALLBACK_INSET;
    const right = area.x + area.width;
    if (!(right >= 0) || right > viewportWidth) return CONTROLS_FALLBACK_INSET;
    return Math.max(0, Math.round(viewportWidth - right));
}

/** The overlay's colours reach the window only as plain `#rrggbb` — what `setTitleBarOverlay` takes. */
export function overlayColorsOk(color: unknown, symbolColor: unknown): boolean {
    const hex = /^#[0-9a-fA-F]{6}$/;
    return typeof color === 'string' && typeof symbolColor === 'string' && hex.test(color) && hex.test(symbolColor);
}

/** THE GENIE BROWSER WINDOW (beta.35 item 36): Genie 1's size and minimum, the main window's frame (its chrome owns the top). */
export function browserWindowOptions(platform: NodeJS.Platform): MainWindowOptions {
    const base = { width: 1200, height: 820, minWidth: 720, minHeight: 480, titleBarStyle: 'hidden' as const };
    if (platform === 'darwin') return base;
    return { ...base, titleBarOverlay: { height: TITLE_BAR_HEIGHT, color: '#0a0a0c', symbolColor: '#e4e4e7' } };
}

export function mainWindowOptions(platform: NodeJS.Platform): MainWindowOptions {
    const base = { width: 1440, height: 900, minWidth: 980, minHeight: 620, titleBarStyle: 'hidden' as const };
    if (platform === 'darwin') return base;
    return { ...base, titleBarOverlay: { height: TITLE_BAR_HEIGHT, color: '#0a0a0c', symbolColor: '#e4e4e7' } };
}

/**
 * THE HOST DIRECTORY'S WINDOW (Tynn #1058 L4): Genie's frame, as the main window's (the OS title bar hidden, the native
 * buttons an overlay the height of Genie's bar), its overlay in the bar's own colours (`--bg-1`) for the page's theme,
 * which follows the OS (`dark`: Electron's nativeTheme.shouldUseDarkColors).
 */
export function hostDirectoryWindowOptions(platform: NodeJS.Platform, dark: boolean): MainWindowOptions {
    const base = { width: 1100, height: 720, minWidth: 640, minHeight: 480, titleBarStyle: 'hidden' as const };
    if (platform === 'darwin') return base;
    return { ...base, titleBarOverlay: dark ? { height: TITLE_BAR_HEIGHT, color: '#15151a', symbolColor: '#e4e4e7' } : { height: TITLE_BAR_HEIGHT, color: '#fafafa', symbolColor: '#18181b' } };
}
