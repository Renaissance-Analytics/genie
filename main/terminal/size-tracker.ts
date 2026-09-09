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

/** One grid a pty was driven to, and when. */
export interface TerminalSizeEvent {
    cols: number;
    rows: number;
    /** ms since this process started (monotonic — the wall clock can step). */
    at: number;
}

/**
 * DIAGNOSTIC (suite only): every grid a terminal was driven to, oldest first.
 *
 * The tracker above answers "where is this pty NOW", which is all the product
 * needs. A test asserting a NON-EVENT — genie#229's "the panel a workspace
 * switch hid never drove its pty" — is asking something else: was it EVER moved,
 * and when. A last-applied size cannot tell a pty that never moved from one that
 * moved and was put back, and the E2E spec that leant on it flaked for precisely
 * that reason (genie#542): it compared against a snapshot taken before an earlier
 * layout change had finished reaching the pty, so the CORRECT resize landing a
 * moment later read as a fit against a hidden panel.
 *
 * Off unless `GENIE_E2E=1`. A long-lived session keeps one terminal for days and
 * must not pay for a list only the suite reads.
 */
const HISTORY_LIMIT = 200;
const history = new Map<string, TerminalSizeEvent[]>();

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
    if (process.env.GENIE_E2E !== '1') return;
    const log = history.get(id) ?? [];
    log.push({ cols, rows, at: Math.round(performance.now()) });
    // Drop the OLDEST when full: a failure is about the resizes around it, so
    // keeping the head instead would keep the useless half of the list.
    if (log.length > HISTORY_LIMIT) log.splice(0, log.length - HISTORY_LIMIT);
    history.set(id, log);
}

/**
 * Every grid this terminal was driven to, oldest first — `[]` when the history is
 * off. Diagnostic: never branch product behaviour on it.
 */
export function getTerminalSizeHistory(id: string): TerminalSizeEvent[] {
    return history.get(id) ?? [];
}

/** The last-applied size for a terminal, or null if none has been recorded. */
export function getTerminalSize(id: string): { cols: number; rows: number } | null {
    return sizes.get(id) ?? null;
}

/** Forget a terminal's size (on exit) so a reused id starts clean. */
export function forgetTerminalSize(id: string): void {
    sizes.delete(id);
    history.delete(id);
}
