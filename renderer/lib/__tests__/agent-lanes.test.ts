import { describe, expect, it } from 'vitest';
import {
    agentLanes,
    laneOffset,
    laneRangeQuery,
    laneTimeAt,
    parseLaneRange,
    rowsInLaneRange,
    LANE_IDS,
} from '../agent-lanes';
import type { StreamRow } from '../agent-stream';

/**
 * THE LANES PULLDOWN (§5.2).
 *
 * The board: *"The Lanes pulldown (L) opens messages, thoughts, tools and edits as lanes
 * over the current turn. Dragging across a range filters the stream below; the range is
 * kept in the URL."*
 *
 * Pure, like every other decision in this renderer, because the test environment has no
 * DOM and a rule living inside a component is a rule nobody checks. `AgentStream.tsx`
 * described this feature in a comment for an entire release while no implementation
 * existed — prose is not a mechanism.
 *
 * The lanes are derived from `StreamRow[]`, the same list the stream renders, rather than
 * from the session directly. Two derivations of "what happened" would be two things to
 * disagree, and the one thing a filter must never do is hide a row the stream would show
 * for a reason the stream does not know about.
 */

const row = (over: Partial<StreamRow> & { id: string }): StreamRow => ({
    type: 'event',
    kind: 'tool',
    main: 'something',
    meta: null,
    at: 1_000,
    live: false,
    level: null,
    ...over,
});

describe('which lanes exist', () => {
    it('is the board’s four, in its order', () => {
        expect(LANE_IDS).toEqual(['messages', 'thoughts', 'tools', 'edits']);
    });
});

describe('placing rows into lanes', () => {
    const rows: StreamRow[] = [
        row({ id: 'm1', type: 'speech', kind: null, at: 100 }),
        row({ id: 't1', kind: 'think', at: 200 }),
        row({ id: 'c1', kind: 'tool', at: 300 }),
        row({ id: 'e1', kind: 'edit', at: 400 }),
    ];

    it('routes each kind to its own lane', () => {
        const view = agentLanes(rows);
        const byId = new Map(view.lanes.map((l) => [l.id, l]));
        expect(byId.get('messages')!.ticks.map((t) => t.id)).toEqual(['m1']);
        expect(byId.get('thoughts')!.ticks.map((t) => t.id)).toEqual(['t1']);
        expect(byId.get('tools')!.ticks.map((t) => t.id)).toEqual(['c1']);
        expect(byId.get('edits')!.ticks.map((t) => t.id)).toEqual(['e1']);
    });

    it('keeps every lane present even when empty, so the gutter does not reflow', () => {
        // A lane that vanishes when idle moves the three below it mid-turn, which is the
        // one thing a timeline must not do while you are dragging across it.
        const view = agentLanes([row({ id: 'c1', kind: 'tool', at: 300 })]);
        expect(view.lanes.map((l) => l.id)).toEqual(LANE_IDS);
    });

    it('spans from the first stamped row to the last', () => {
        expect(agentLanes(rows).span).toEqual({ from: 100, to: 400 });
    });

    it('has NO span when nothing is stamped — not a zero-width one', () => {
        // `null` means "cannot place these in time", and it is different from an instant.
        // A zero-width span would make every position 0 and draw four lanes of ticks
        // stacked on the left edge, which reads as data rather than as absence.
        expect(agentLanes([row({ id: 'x', at: null })]).span).toBeNull();
    });

    it('counts what it could not place rather than dropping it silently', () => {
        const view = agentLanes([row({ id: 'a', at: 100 }), row({ id: 'b', at: null })]);
        expect(view.unplaceable).toBe(1);
    });

    it('never places a DIVIDER — it is punctuation, not an event', () => {
        const view = agentLanes([row({ id: 'd', type: 'divider', kind: null, at: 150 })]);
        expect(view.lanes.every((l) => l.ticks.length === 0)).toBe(true);
    });
});

describe('the range filters the stream', () => {
    const rows: StreamRow[] = [
        row({ id: 'a', at: 100 }),
        row({ id: 'b', at: 200 }),
        row({ id: 'c', at: 300 }),
    ];

    it('keeps rows inside the range, inclusive at both ends', () => {
        // Inclusive because the handles are dragged ONTO ticks. An exclusive end would drop
        // the row you just pointed at, which reads as the filter being broken.
        expect(rowsInLaneRange(rows, { from: 100, to: 200 }).map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('is the whole stream when there is no range', () => {
        expect(rowsInLaneRange(rows, null)).toHaveLength(3);
    });

    it('KEEPS an unstamped row, because it cannot be known to be outside', () => {
        // The load-bearing `null` rule: absence of a timestamp is "cannot see", not "did not
        // happen then". Hiding it would assert it falls outside a window nothing can place
        // it in, and a filter that silently drops what it cannot judge is worse than a noisy
        // one -- the row it drops is invisible, so nobody learns it was dropped.
        const withUnstamped = [...rows, row({ id: 'u', at: null })];
        expect(rowsInLaneRange(withUnstamped, { from: 100, to: 100 }).map((r) => r.id)).toEqual([
            'a',
            'u',
        ]);
    });

    it('POSITIVE CONTROL: a range really does remove something', () => {
        // Without this, "keeps the unstamped row" would also pass against a filter that
        // keeps everything always.
        expect(rowsInLaneRange(rows, { from: 300, to: 300 }).map((r) => r.id)).toEqual(['c']);
    });
});

describe('turning a drag into a time', () => {
    const span = { from: 1_000, to: 2_000 };

    it('maps the strip onto the span', () => {
        expect(laneTimeAt(0, span)).toBe(1_000);
        expect(laneTimeAt(0.5, span)).toBe(1_500);
        expect(laneTimeAt(1, span)).toBe(2_000);
    });

    it('CLAMPS, because a pointer leaves the element mid-drag', () => {
        // Unclamped, dragging past the edge selects a window outside the turn and the stream
        // below empties — which reads as the filter deleting everything.
        expect(laneTimeAt(-3, span)).toBe(1_000);
        expect(laneTimeAt(9, span)).toBe(2_000);
    });

    it('round-trips against laneOffset', () => {
        expect(laneOffset(laneTimeAt(0.25, span), span)).toBeCloseTo(0.25, 5);
    });
});

describe('the range survives a refresh', () => {
    it('round-trips through the url', () => {
        expect(parseLaneRange(laneRangeQuery({ from: 100, to: 400 }))).toEqual({ from: 100, to: 400 });
    });

    it('is absent from the url when there is no range, keeping the default clean', () => {
        expect(laneRangeQuery(null)).toBeNull();
    });

    it('refuses nonsense rather than filtering to an accidental window', () => {
        // A malformed range that parsed to SOMETHING would hide most of the stream and look
        // like data loss. Null means "no filter", which is the safe reading.
        expect(parseLaneRange('')).toBeNull();
        expect(parseLaneRange('abc')).toBeNull();
        expect(parseLaneRange('100')).toBeNull();
        expect(parseLaneRange('100-')).toBeNull();
        expect(parseLaneRange('x-400')).toBeNull();
    });

    it('normalises a backwards range rather than returning nothing', () => {
        // Dragging right-to-left is the same selection. Returning null would make the
        // filter silently fail for half of all drags.
        expect(parseLaneRange('400-100')).toEqual({ from: 100, to: 400 });
    });
});
