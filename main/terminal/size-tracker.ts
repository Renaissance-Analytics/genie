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

/**
 * Is this a grid we can actually drive a pty to? Guards every size that crosses a
 * process/wire boundary — a remote `create` body, a `resize` frame, a tracked size.
 * `undefined` (caller simply has no grid yet) and garbage (NaN, 0, negative) are
 * both rejected, so callers can fall back to the engine default instead of
 * spawning an unusable 0-column pty.
 */
export function isUsableGrid<T extends { cols?: number; rows?: number }>(
    grid: T,
): grid is T & { cols: number; rows: number } {
    const { cols, rows } = grid;
    if (typeof cols !== 'number' || typeof rows !== 'number') return false;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
    return cols > 0 && rows > 0;
}

/** Record the size a resize just applied (call only on a successful resize). */
export function recordTerminalSize(id: string, cols: number, rows: number): void {
    if (!id) return;
    if (!isUsableGrid({ cols, rows })) return;
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
