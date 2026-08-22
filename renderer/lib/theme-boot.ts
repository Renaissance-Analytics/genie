/**
 * Theme resolution that has to happen BEFORE the first paint (genie#229).
 *
 * Genie is a dark app, but its dark palette hangs off a `.dark` class on
 * <html>: bare `:root` in globals.css IS the light theme (`--bg-0: #ffffff`),
 * and `.dark` overrides it. That inversion is only safe if the class is on the
 * element by the time the first frame paints.
 *
 * It was not. `_app.tsx` applied it from a `useEffect`, which React runs AFTER
 * paint — and `master.html` ships, prerendered as its entire <body>, the
 * `.boot-screen` overlay (`position: fixed; inset: 0; z-index: 9999`) whose
 * `:root:not(.dark)` variant is a near-white `#f5f3ff → #eef2ff` radial. So
 * every frame between first paint and hydration was a WHITE FULL-SCREEN
 * window. Capturing frames from the shipped 0.7.0-beta.265 `app/master.html`
 * offscreen showed 4 consecutive frames at luma 249–255 of 255 before it
 * flipped dark — the flash the owner reports.
 *
 * The fix is the standard no-FOUC one: a BLOCKING inline <script> in <head>
 * (injected by `_document.tsx`) that resolves the same preference and sets the
 * class before anything paints. `_app.tsx` keeps applying it at runtime — that
 * is what tracks a live OS theme flip — but it is no longer what decides the
 * first frame.
 *
 * `resolveDarkTheme` and `THEME_BOOT_SCRIPT` MUST agree; the script cannot
 * import (it runs with no bundle loaded), so the tests pin both to one truth
 * table and a divergence fails there.
 */

/** Where Settings → Customization persists the choice. */
export const THEME_STORAGE_KEY = 'genie.theme';

/** The stored preference. Anything else (unset, legacy) means 'system'. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** The media query that defines "the OS wants dark". */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Whether the `dark` class belongs on <html>, given the stored preference and
 * whether the OS currently prefers dark. An explicit 'light'/'dark' pins the
 * theme and ignores the OS; 'system' — and any unset/unknown/legacy value —
 * follows it.
 */
export function resolveDarkTheme(
    saved: string | null | undefined,
    prefersDark: boolean,
): boolean {
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return prefersDark;
}

/**
 * The inline script `_document.tsx` puts in <head>. It runs synchronously,
 * before the first paint and before any chunk has loaded, so it is written as
 * a self-contained ES5 IIFE with no imports and no DOMContentLoaded wait.
 *
 * Every step is defensive: a hardened/private-mode profile can make
 * `localStorage` THROW on read, and a stripped environment can lack
 * `matchMedia`. Either must degrade to "no class" rather than throw, because a
 * throw here would take the whole document's head script with it.
 *
 * Mirrors `resolveDarkTheme` — keep the two in step (see the module note).
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var saved=null;
try{saved=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});}catch(e){}
var dark;
if(saved==='dark'){dark=true;}
else if(saved==='light'){dark=false;}
else{dark=!!(window.matchMedia&&window.matchMedia(${JSON.stringify(PREFERS_DARK_QUERY)}).matches);}
document.documentElement.classList.toggle('dark',dark);
}catch(e){}})();`;
