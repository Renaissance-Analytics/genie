import { LANES, laneOf, type Lane, type TimedEvent } from './stream-view.js';

/**
 * LANES — four tracks over the current turn, and the sentence that replaces them.
 *
 * ## The rule this module exists for
 *
 * > **With no timestamped rows, Lanes renders a sentence, not four empty tracks.**
 *
 * Empty tracks read as *"nothing happened"*. The truth in that case is *"Genie has no times
 * for these"* — a thread replayed from storage that kept no timestamps — and those are
 * different claims about somebody's work. The counts stay real either way: what is missing is
 * **when**, not **whether**.
 *
 * ## The selection lives in the route
 *
 * `?lane=messages,edits`, so a filtered view is linkable and survives a refresh — and so an
 * agent can hand a human a link to the edits of one turn.
 */

export type { Lane };

/**
 * Parse `?lane=` into a selection.
 *
 * `null` (absent) means **not filtering**; an empty string means **filtering to nothing**, and
 * the Stream then shows only what cannot be filtered out — the compaction divider. Collapsing
 * the two would make "show me nothing" impossible to express.
 *
 * An unrecognised name is **dropped rather than fatal**: a stale link from an older version
 * must still open. A slightly wider stream is recoverable; a blank surface is not.
 */
export function parseLanes(value: string | null): readonly Lane[] | null {
    if (value === null) return null;
    if (value === '') return [];

    const seen = new Set<Lane>();
    for (const part of value.split(',')) {
        const lane = part.trim();
        if ((LANES as readonly string[]).includes(lane)) seen.add(lane as Lane);
    }
    return [...seen];
}

/** The inverse. `null` stays absent rather than becoming an empty parameter. */
export function formatLanes(lanes: readonly Lane[] | null): string | null {
    if (lanes === null) return null;
    return lanes.join(',');
}

export interface LaneSummary {
    /** Whether tracks can honestly be drawn. */
    drawable: boolean;
    /** Why not, when they cannot. A sentence for the reader, not a code. */
    reason: string | null;
    /**
     * How many rows are in each lane.
     *
     * Real even when `drawable` is false, and a **measured zero is kept**: a turn with no edits
     * genuinely has none, and the reader asking "did it change anything?" is answered by `0`.
     */
    counts: Record<Lane, number>;
}

export function laneSummary(rows: readonly TimedEvent[]): LaneSummary {
    const counts = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
    for (const row of rows) {
        const lane = laneOf(row.event);
        if (lane) counts[lane] += 1;
    }

    if (rows.length === 0) {
        return { drawable: false, reason: 'Nothing has happened in this turn yet.', counts };
    }

    // SOME timed rows is enough. Refusing because one row lacks a time would hide a usable
    // view over a technicality.
    const anyTimed = rows.some((row) => row.at !== null);
    if (!anyTimed) {
        return {
            drawable: false,
            reason: 'Genie has no times for these events, so there is nothing to lay out. The counts below are real.',
            counts,
        };
    }

    return { drawable: true, reason: null, counts };
}
