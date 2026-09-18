/**
 * Native chrome cannot resolve the renderer's CSS variables. Keep its two
 * palettes beside the bridge that applies the renderer's resolved theme, so a
 * hidden-titlebar window does not retain a dark Windows control strip while the
 * page underneath it is light.
 */
export function windowThemePalette(dark: boolean): {
    backgroundColor: string;
    overlayColor: string;
    symbolColor: string;
} {
    return dark
        ? {
              backgroundColor: '#09090b',
              overlayColor: '#09090b',
              symbolColor: '#a1a1aa',
          }
        : {
              backgroundColor: '#ffffff',
              overlayColor: '#ffffff',
              symbolColor: '#18181b',
          };
}

type ThemeableWindow = {
    isDestroyed(): boolean;
    setBackgroundColor(color: string): void;
    setTitleBarOverlay(options: {
        color: string;
        symbolColor: string;
        height: number;
    }): void;
};

const overlayHeights = new WeakMap<object, number>();

/** Remember the custom overlay height chosen when this BrowserWindow was made. */
export function rememberTitleBarOverlay(win: object, height: number): void {
    overlayHeights.set(win, height);
}

/** Apply the already-resolved renderer theme to this window's native frame. */
export function applyWindowTheme(win: ThemeableWindow, dark: boolean): void {
    if (win.isDestroyed()) return;
    const palette = windowThemePalette(dark);
    win.setBackgroundColor(palette.backgroundColor);
    const height = overlayHeights.get(win);
    if (height === undefined) return;
    win.setTitleBarOverlay({
        color: palette.overlayColor,
        symbolColor: palette.symbolColor,
        height,
    });
}

/** Constructor-time options, before the renderer can report its saved choice. */
export function initialWindowTheme(dark: boolean, titleBarHeight?: number): {
    backgroundColor: string;
    titleBarOverlay?: { color: string; symbolColor: string; height: number };
} {
    const palette = windowThemePalette(dark);
    return {
        backgroundColor: palette.backgroundColor,
        ...(titleBarHeight === undefined
            ? {}
            : {
                  titleBarOverlay: {
                      color: palette.overlayColor,
                      symbolColor: palette.symbolColor,
                      height: titleBarHeight,
                  },
              }),
    };
}
