import type { StreamLevel, StreamRow } from './agent-stream';

/**
 * THE LANES PULLDOWN — §5.2 of the spec board.
 *
 * *"The Lanes pulldown (L) opens messages, thoughts, tools and edits as lanes over the
 * current turn. Dragging across a range filters the stream below; the range is kept in the
 * URL."*
 *
 * ## Derived from the STREAM, not from the session
 *
 * `agentStream` already decided what happened and in what order — including which tool
 * calls count as edits, which is taken from the agent's own `kind` rather than from a tool's
 * name. Deriving lanes from the session again would be a second answer to the same question,
 * and the two would eventually disagree about what an edit is. Then a filter would hide rows
 * the stream shows, for a reason the stream does not know about.
 *
 * ## Time is a fact Genie may not have
 *
 * `StreamRow.at` is nullable, and that nullability is load-bearing here in two places: a
 * stream with nothing stamped has NO span rather than a zero-width one, and an unstamped row
 * is never filtered out, because "I cannot place this in time" is not "this happened outside
 * your window". A filter that silently drops what it cannot judge is the worse failure — the
 * dropped row is invisible, so nobody learns it was dropped.
 */

export const LANE_IDS = ['messages', 'thoughts', 'tools', 'edits'] as const;

export type LaneId = (typeof LANE_IDS)[number];

export const LANE_LABEL: Record<LaneId, string> = {
    messages: 'Messages',
    thoughts: 'Thoughts',
    tools: 'Tools',
    edits: 'Edits',
};

export interface LaneTick {
    /** The stream row's id, so clicking a tick can select the row it came from. */
    id: string;
    at: number;
    level: StreamLevel;
    live: boolean;
}

export interface Lane {
    id: LaneId;
    label: string;
    ticks: LaneTick[];
}

export interface LaneSpan {
    from: number;
    to: number;
}

export interface LanesView {
    lanes: Lane[];
    /** The time the lanes cover, or null when nothing in the stream is stamped. */
    span: LaneSpan | null;
    /** How many rows carried no timestamp. Reported, never silently dropped. */
    unplaceable: number;
}

/** Which lane a row belongs to, or null when it is not an event at all. */
function laneOf(r: StreamRow): LaneId | null {
    // Speech is the only non-event that lands in a lane: a message IS one of the four.
    if (r.type === 'speech') return 'messages';
    // A divider is punctuation — "context compacted", "you took over here". It marks the
    // stream rather than being a thing that happened in it, so it gets no tick.
    if (r.type !== 'event') return null;
    if (r.kind === 'think') return 'thoughts';
    if (r.kind === 'edit') return 'edits';
    if (r.kind === 'tool') return 'tools';
    // `plan` and `usage` are STATE, not events on a timeline: a plan mutates in place and
    // usage is a running total, so a tick for either would claim a moment neither has.
    return null;
}

export function agentLanes(rows: readonly StreamRow[]): LanesView {
    const ticks = new Map<LaneId, LaneTick[]>(LANE_IDS.map((id) => [id, []]));
    let unplaceable = 0;
    let from: number | null = null;
    let to: number | null = null;

    for (const r of rows) {
        const lane = laneOf(r);
        if (lane === null) continue;
        if (r.at === null) {
            unplaceable += 1;
            continue;
        }
        ticks.get(lane)!.push({ id: r.id, at: r.at, level: r.level, live: r.live });
        if (from === null || r.at < from) from = r.at;
        if (to === null || r.at > to) to = r.at;
    }

    return {
        // Every lane is present even when empty: one that vanishes when idle moves the lanes
        // below it mid-turn, and the lanes are the thing being dragged across.
        lanes: LANE_IDS.map((id) => ({ id, label: LANE_LABEL[id], ticks: ticks.get(id)! })),
        span: from === null || to === null ? null : { from, to },
        unplaceable,
    };
}

/**
 * Where a tick sits in its span, 0..1.
 *
 * A zero-width span returns 0 rather than dividing by it — one stamped row is a real stream,
 * and `NaN` here would place every tick nowhere and render an empty timeline that looks like
 * a bug in the data.
 */
export function laneOffset(at: number, span: LaneSpan): number {
    const width = span.to - span.from;
    if (width <= 0) return 0;
    return Math.min(1, Math.max(0, (at - span.from) / width));
}

/**
 * The inverse of {@link laneOffset} — what time a fraction of the strip's width means.
 *
 * Here rather than in the component because it is the half of the drag that decides what
 * gets filtered, and a rule inside a pointer handler is a rule no test can reach. The
 * fraction is clamped: a pointer can leave the element mid-drag, and an unclamped value
 * would select a window outside the turn entirely.
 */
export function laneTimeAt(fraction: number, span: LaneSpan): number {
    const f = Math.min(1, Math.max(0, fraction));
    return Math.round(span.from + (span.to - span.from) * f);
}

/** The rows a range admits. Inclusive at both ends — the handles are dragged onto ticks. */
export function rowsInLaneRange(rows: readonly StreamRow[], range: LaneSpan | null): StreamRow[] {
    if (!range) return [...rows];
    // `at === null` is KEPT. See the module comment: absence of a timestamp is "cannot see",
    // and excluding it would assert it falls outside a window nothing can place it in.
    return rows.filter((r) => r.at === null || (r.at >= range.from && r.at <= range.to));
}

/** `?lanes=<from>-<to>`, or null when there is no range and the url should stay clean. */
export function laneRangeQuery(range: LaneSpan | null): string | null {
    if (!range) return null;
    return `${range.from}-${range.to}`;
}

/**
 * Read a range back out of the url.
 *
 * Anything malformed is `null` — no filter — rather than a best guess. A range that parsed
 * to SOMETHING would hide most of the stream and read as data loss, which is a far more
 * expensive failure than ignoring a broken link.
 */
export function parseLaneRange(raw: string | null | undefined): LaneSpan | null {
    if (!raw) return null;
    const m = /^(-?\d+)-(-?\d+)$/.exec(raw.trim());
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    // Dragging right-to-left selects the same window. Returning null for a backwards range
    // would make the filter silently fail for half of all drags.
    return a <= b ? { from: a, to: b } : { from: b, to: a };
}
