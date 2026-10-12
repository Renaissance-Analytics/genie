import { FILTERS, LANES, laneOf, type Lane, type StreamFilter, type TimedEvent } from './stream-view.js';

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

export type { Lane, StreamFilter };

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
export function parseLanes(value: string | null): readonly StreamFilter[] | null {
    if (value === null) return null;
    if (value === '') return [];

    const seen = new Set<StreamFilter>();
    for (const part of value.split(',')) {
        const lane = part.trim();
        // A lane or a facet (the chips row's Usage / Errors) — the same parameter carries both.
        if ((FILTERS as readonly string[]).includes(lane)) seen.add(lane as StreamFilter);
    }
    return [...seen];
}

/** The inverse. `null` stays absent rather than becoming an empty parameter. */
export function formatLanes(lanes: readonly StreamFilter[] | null): string | null {
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

/* ────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A time range over the stream — "dragging across a range filters the stream below; the range
 * is kept in the URL" (§4.2). Epoch milliseconds, inclusive at both ends.
 */
export interface TimeRange {
    from: number;
    to: number;
}

/**
 * Parse `?range=<from>-<to>`.
 *
 * `null` for absent, and `null` for ANYTHING malformed: a stale or hand-edited link must still
 * open the agent, and a wider stream is recoverable where a blank surface is not. The parser
 * insists on canonical order (`from <= to`); the formatter is where a reversed drag is put in
 * order, so what reaches a link is always canonical.
 */
export function parseRange(value: string | null): TimeRange | null {
    if (value === null) return null;
    const match = /^(\d+)-(\d+)$/.exec(value);
    if (!match) return null;
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return null;
    return { from, to };
}

/** The inverse. Orders the ends, because a human can drag right-to-left. */
export function formatRange(range: TimeRange | null): string | null {
    if (range === null) return null;
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    return `${from}-${to}`;
}

export interface Timeline {
    /** The span, in epoch ms. `start === end` for a single instant. */
    start: number;
    end: number;
    /** One tick per EDIT, as a fraction 0..1 of the span. Edits with no time are not ticks. */
    ticks: readonly { id: string; x: number }[];
}

/**
 * The timeline: where the edits are, as fractions of the turn's span.
 *
 * "Timeline ticks place every edit in the session" (§4.2). Only edits, because the timeline
 * answers *where did it change something?*, which is the question Lanes exists for. Positions
 * are fractions so the component can draw them at any width without knowing the times.
 *
 * `null` when there is no span — nothing timed at all. A tick "at 0..1 of nothing" would be a
 * lie about position, and `laneSummary` already renders the sentence for that case. A single
 * instant is a span of zero width and draws with every tick at 0.5: it happened, here.
 */
export function timelineOf(rows: readonly TimedEvent[]): Timeline | null {
    const times = rows.map((r) => r.at).filter((t): t is number => t !== null);
    if (times.length === 0) return null;

    const start = Math.min(...times);
    const end = Math.max(...times);
    const span = end - start;

    const ticks = rows
        .filter((r) => laneOf(r.event) === 'edits' && r.at !== null)
        .map((r) => ({ id: r.id, x: span === 0 ? 0.5 : ((r.at as number) - start) / span }));

    return { start, end, ticks };
}

/**
 * THE FOUR TRACKS (the board's drawer): one block per event in its lane, placed by the fraction of the span. Untimed
 * rows and structure rows (turn markers, the compaction divider) draw none — a block is a claim about WHEN.
 */
export interface LaneTrack {
    lane: Lane;
    blocks: readonly { id: string; x: number }[];
}

export function laneTracks(rows: readonly TimedEvent[], timeline: Timeline): readonly LaneTrack[] {
    const span = timeline.end - timeline.start;
    const at = (t: number): number => (span === 0 ? 0.5 : Math.round(((t - timeline.start) / span) * 1000) / 1000);
    return LANES.map((lane) => ({
        lane,
        blocks: rows.filter((r) => r.at !== null && laneOf(r.event) === lane).map((r) => ({ id: r.id, x: at(r.at as number) })),
    }));
}

/** Whether the span's end is close enough to now to be called `now` (the board's `14:02 – now`). */
export const NOW_WITHIN_MS = 60_000;

const clock = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const clockS = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour12: false });

/**
 * THE DRAWER'S LABELS (the board): the span — `Turn 14 · 14:02 – now` (the latest turn marker, the first time, `now`
 * while the end is recent, else its clock); the selection — `selected 14:07:40 – 14:09:00 · 31 events` while a range
 * is set (rows inside it, structure rows excluded); the axis — five clocks across the span, the last `now` when it is.
 */
export function drawerLabels(rows: readonly TimedEvent[], timeline: Timeline, range: TimeRange | null, now: number): { span: string; selected: string | null; axis: readonly string[] } {
    const live = now - timeline.end <= NOW_WITHIN_MS;
    const end = live ? 'now' : clock(timeline.end);
    const latestTurn = [...rows].reverse().find((r) => r.event.kind === 'turn');
    const turn = latestTurn && latestTurn.event.kind === 'turn' ? `Turn ${latestTurn.event.n} · ` : '';
    const span = `${turn}${clock(timeline.start)} – ${end}`;
    let selected: string | null = null;
    if (range) {
        const inside = rows.filter((r) => r.at !== null && r.at >= range.from && r.at <= range.to && r.event.kind !== 'turn' && r.event.kind !== 'divider').length;
        selected = `selected ${clockS(range.from)} – ${clockS(range.to)} · ${inside} event${inside === 1 ? '' : 's'}`;
    }
    const axis = [0, 0.25, 0.5, 0.75, 1].map((f, i) => (i === 4 && live ? 'now' : clock(timeAt(timeline, f))));
    return { span, selected, axis };
}

/** A fraction of the span back to a time, clamped to the span. A pointer released off the bar is the edge. */
export function timeAt(timeline: Timeline, fraction: number): number {
    const f = Math.min(1, Math.max(0, fraction));
    return Math.round(timeline.start + (timeline.end - timeline.start) * f);
}

/**
 * The rows inside a range, inclusive.
 *
 * Two rules beyond the arithmetic:
 *  - **a compaction divider is NEVER dropped**, whatever the range — the same rule `visibleRows`
 *    keeps for lanes. Silent amnesia is the top cause of "why did it get stupid", and a range
 *    that hid the moment it forgot would be the worst version;
 *  - **a row with no time is dropped once a range is active.** It cannot be placed in one, and
 *    keeping it would show something as "within these forty seconds" that Genie cannot place.
 */
export function rowsInRange(rows: readonly TimedEvent[], range: TimeRange | null): readonly TimedEvent[] {
    if (range === null) return rows;
    return rows.filter((row) => {
        if (row.event.kind === 'divider') return true;
        return row.at !== null && row.at >= range.from && row.at <= range.to;
    });
}

/**
 * `E` — the id of the next edit after the current row, wrapping to the first.
 *
 * From nothing selected, the first edit. From a non-edit row, the next edit after it. From the
 * last edit, the first again: a key that does nothing at the end reads as broken. `null` only
 * when there are no edits at all — never a non-edit row.
 */
export function nextEditAfter(rows: readonly TimedEvent[], currentId: string | null): string | null {
    // An edit is a tool call whose kind the provider reported as `edit` — `laneOf` is the one
    // place that classification lives, so the timeline and `E` cannot disagree with the lanes.
    const edits = rows.map((r, i) => ({ r, i })).filter(({ r }) => laneOf(r.event) === 'edits');
    if (edits.length === 0) return null;

    const position = currentId === null ? -1 : rows.findIndex((r) => r.id === currentId);
    const next = edits.find(({ i }) => i > position);
    return (next ?? edits[0])?.r.id ?? null;
}

/**
 * A drag across the bar, as a range.
 *
 * Two fractions of the bar's width — where the pointer went down and where it is now — in
 * either order, each clamped to the bar. A drag of zero width is a click, and a click is not
 * a range: `null`, so a mis-click does not filter the stream to nothing.
 */
export function rangeFromDrag(timeline: Timeline, a: number, b: number): TimeRange | null {
    const from = timeAt(timeline, Math.min(a, b));
    const to = timeAt(timeline, Math.max(a, b));
    if (from === to) return null;
    return { from, to };
}
