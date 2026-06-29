/**
 * OS-level "demand attention" for the window that hosts an alerting workspace
 * (imDone / ForceTheQuestion). Complements the in-window glow: when the right
 * window isn't focused, flash it at the OS level so the user notices even when
 * Genie is behind other apps or on another monitor.
 *
 *   - Windows / Linux → `win.flashFrame(true)` (taskbar flash / urgency hint),
 *     cleared on the window's next `focus`.
 *   - macOS → `app.dock.bounce('critical')` (bounces until the app is
 *     activated; self-cancels on focus).
 *
 * Multi-window: Genie can have MANY windows open at once — the local master
 * window plus one host window per connected remote host. The flash must target
 * the SPECIFIC window viewing the alerting workspace, never just the master.
 * `resolveAttentionWindow` encodes that mapping; the caller flashes the result.
 */

// Type-only import so the pure decisions below stay electron-free and unit-
// testable; the imperative `demandWindowAttention` lazy-requires electron.
import type { BrowserWindow } from 'electron';

/** The window slice the flash decision needs (structural → testable). */
export interface FlashWindow {
    isDestroyed(): boolean;
    isFocused(): boolean;
}

/**
 * Whether to flash a window for attention: only when it EXISTS, isn't
 * destroyed, and isn't already focused. A focused window already has the
 * user's eyes — flashing it would be noise. Pure → unit-testable.
 */
export function shouldFlashWindow(win: FlashWindow | null | undefined): boolean {
    return !!win && !win.isDestroyed() && !win.isFocused();
}

/**
 * Pick the window that HOSTS an alerting workspace, among potentially many:
 * a remote host window when the workspace lives on a bound connection
 * (`connKey`), otherwise the local master window. Returns null when the
 * intended window isn't open. Pure → unit-testable; mirrors the multi-host
 * window map (`hostWindows` keyed by connKey).
 */
export function resolveAttentionWindow<W>(
    connKey: string | null | undefined,
    master: W | null | undefined,
    hostWindows: ReadonlyMap<string, W>,
): W | null {
    if (connKey) return hostWindows.get(connKey) ?? null;
    return master ?? null;
}

/** Windows currently flashing (Windows/Linux) — avoids re-arming the one-shot
 *  focus listener on repeated alerts before the user looks. */
const flashing = new WeakSet<object>();

/**
 * Flash the given window for attention if it isn't focused (no-op when it's
 * focused / destroyed / missing). Safe to call on every alert.
 */
export function demandWindowAttention(win: BrowserWindow | null | undefined): void {
    if (!shouldFlashWindow(win)) return;
    const w = win as BrowserWindow;
    // Lazy require keeps the pure exports above free of a runtime electron
    // dependency (so they unit-test without mocking electron).
    const { app } = require('electron') as typeof import('electron');
    if (process.platform === 'darwin') {
        // Bounces the dock icon until the app is activated; self-cancels on
        // focus, so there's nothing to clear.
        app.dock?.bounce('critical');
        return;
    }
    // Windows / Linux: flash the taskbar entry until the window is focused.
    if (flashing.has(w)) return;
    flashing.add(w);
    w.flashFrame(true);
    w.once('focus', () => {
        flashing.delete(w);
        if (!w.isDestroyed()) w.flashFrame(false);
    });
    w.once('closed', () => flashing.delete(w));
}
