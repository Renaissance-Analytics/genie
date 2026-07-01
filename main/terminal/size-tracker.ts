/**
 * Last-applied pty grid per terminal, recorded at EVERY resize (both the desktop
 * `terminal:resize` path and the mobile bridge path). The mobile bridge's
 * repaint-on-drop (see mobile/terminal-bridge.ts) nudges SIGWINCH to make a
 * full-screen TUI re-emit a clean frame after a dropped one — and that nudge MUST
 * restore the pty to its ACTUAL current size, or it would reflow the desktop
 * terminal. This module is the single source of that size, kept in Genie code so
 * the repaint never has to reach into the (Fancy) pty manager for it.
 */
const sizes = new Map<string, { cols: number; rows: number }>();

/** Record the size a resize just applied (call only on a successful resize). */
export function recordTerminalSize(id: string, cols: number, rows: number): void {
    if (!id) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols <= 0 || rows <= 0) return;
    sizes.set(id, { cols, rows });
}

/** The last-applied size for a terminal, or null if none has been recorded. */
export function getTerminalSize(id: string): { cols: number; rows: number } | null {
    return sizes.get(id) ?? null;
}

/** Forget a terminal's size (on exit) so a reused id starts clean. */
export function forgetTerminalSize(id: string): void {
    sizes.delete(id);
}
