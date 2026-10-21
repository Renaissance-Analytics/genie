import type { StreamEvent } from './stream-event.js';

/**
 * WHAT A PERSON READS AS A TURN'S NUMBER: its place in the agent's recorded life — 1, 2, 3 … in order, never a repeat
 * and never a jump (the owner, 2026-10-16 and 2026-10-18: a Turns column reading 268, 270, 269, 268 … and later
 * 54, 54, 55, 55).
 *
 * The number a session writes into a marker is its own count, and threads written before that count was kept right
 * carry repeats for good (a turn cut off by an exit was numbered again by the next run). So every surface reads THIS
 * number, from the one ledger the host serves: the Turns column, the strip, the stream rows and the cards agree because
 * they read the same rows.
 *
 * `before` is the turns that came before these rows; an `earlier` row (the window cut the history) sets it from the
 * turns it cut off. A `stopped` row names the turn it stopped, which is the one it follows. A row that changes nothing
 * is returned as it is, so ids, selections and open rows survive.
 */
export function numberTurns<T extends { readonly event: StreamEvent }>(rows: readonly T[], before = 0): T[] {
    const state = { n: before };
    return rows.map((row) => numberRow(row, state));
}

/**
 * ONE row numbered, `state.n` being the turns before it (and after it, on return) — what `numberTurns` does to each row,
 * for a host that numbers its rows as they ARRIVE rather than all of them again on every read. The row itself when its
 * number stands, so an unchanged row keeps its identity.
 */
export function numberRow<T extends { readonly event: StreamEvent }>(row: T, state: { n: number }): T {
    const e = row.event;
    if (e.kind === 'earlier') {
        if (e.turns !== undefined) state.n = e.turns;
        return row;
    }
    if (e.kind === 'turn') {
        state.n += 1;
        return e.n === state.n ? row : { ...row, event: { ...e, n: state.n } };
    }
    if (e.kind === 'stopped') return e.n === state.n || state.n === 0 ? row : { ...row, event: { ...e, n: state.n } };
    return row;
}

/** The number of the last turn in rows already numbered (0 when none). */
export function lastNumberedTurn(rows: readonly { readonly event: StreamEvent }[]): number {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const e = rows[i]!.event;
        if (e.kind === 'turn') return e.n;
    }
    return 0;
}
