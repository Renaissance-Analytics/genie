import { laneSummary, type Lane } from './lanes.js';
import type { LiveSession } from './roster.js';
import { LANES, laneOf, type TimedEvent } from './stream-view.js';

/**
 * THE SESSION TIMELINE STRIP AND THE CHIPS ROW (the board's `Agent View`).
 *
 * The strip, 46px above the Stream: one segment per turn placed by when it started, one tick per event coloured by
 * KIND, and the head bar at the right in the session's state. The chips row under it is the lane filter as the board
 * draws it — `All 412 · Messages 14 · Thoughts 61 · Tools 288 · Edits 17` — with All on when nothing is filtered.
 *
 * Positions are fractions of the span of every timed row, so the component draws at any width without knowing the
 * times. `null` when nothing is timed: a strip over no span would place things Genie cannot place, and the Lanes
 * drawer already says so in a sentence.
 */

export type TickKind = 'edit' | 'message' | 'thought' | 'tool';
export type TimelineHead = 'ok' | 'warn' | 'bad';

export interface TimelineSegment { label: string; rowId: string; x: number; w: number }
export interface TimelineTick { id: string; x: number; kind: TickKind }

export interface SessionTimeline {
    segments: readonly TimelineSegment[];
    ticks: readonly TimelineTick[];
    /** The session's state at the right edge; `null` when it is not doing anything, or there is no session. */
    head: TimelineHead | null;
}

function tickKind(row: TimedEvent): TickKind | null {
    switch (laneOf(row.event)) {
        case 'edits': return 'edit';
        case 'messages': return 'message';
        case 'thoughts': return 'thought';
        case 'tools': return 'tool';
        default: return null;
    }
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

export function sessionTimeline(rows: readonly TimedEvent[], session: LiveSession | null): SessionTimeline | null {
    const times = rows.map((r) => r.at).filter((t): t is number => t !== null);
    if (times.length === 0) return null;
    const start = Math.min(...times);
    const end = Math.max(...times);
    const span = end - start;
    const at = (t: number): number => (span === 0 ? 0.5 : round((t - start) / span));

    const turns = rows.filter((r) => r.event.kind === 'turn' && r.at !== null);
    const segments: TimelineSegment[] = turns.map((r, i) => {
        const x = at(r.at as number);
        const next = turns[i + 1];
        const w = round((next ? at(next.at as number) : 1) - x);
        return { label: `T${(r.event as { n: number }).n}`, rowId: r.id, x, w };
    });

    const ticks: TimelineTick[] = [];
    for (const r of rows) {
        if (r.at === null) continue;
        const kind = tickKind(r);
        if (kind) ticks.push({ id: r.id, x: at(r.at), kind });
    }

    let head: TimelineHead | null = null;
    if (session) {
        if (session.pendingApproval) head = 'warn';
        else if (session.turnState === 'failed') head = 'bad';
        else if (session.turnState === 'working') head = 'ok';
    }

    return { segments, ticks, head };
}

export interface Chip {
    id: 'all' | Lane;
    label: string;
    /** A measured count — a zero is kept. */
    n: number;
    on: boolean;
}

const LABEL: Record<Lane, string> = { messages: 'Messages', thoughts: 'Thoughts', tools: 'Tools', edits: 'Edits' };

export function chipRow(rows: readonly TimedEvent[], selected: readonly Lane[] | null): readonly Chip[] {
    const counts = laneSummary(rows).counts;
    return [
        { id: 'all', label: 'All', n: rows.length, on: selected === null },
        ...LANES.map((lane): Chip => ({ id: lane, label: LABEL[lane], n: counts[lane], on: selected !== null && selected.includes(lane) })),
    ];
}
