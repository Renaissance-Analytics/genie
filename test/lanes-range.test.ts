import { describe, expect, it } from 'vitest';
import { formatRange, nextEditAfter, parseRange, rangeFromDrag, rowsInRange, timeAt, timelineOf } from '../src/core/lanes.js';

/**
 * LANES, the rest of §4.2: "Dragging across a range filters the stream below; the range is
 * kept in the URL. Timeline ticks place every edit in the session; `E` jumps to the next."
 *
 * All pure. The drag itself is pointer events in `Lanes.tsx`; what it produces is a range,
 * and everything about a range is proven here without a window.
 */

// An EDIT is a tool call the provider classified as `edit` — the only shape `laneOf` files
// under the edits lane, and therefore the only thing the timeline ticks and `E` may see.
const edit = (id: string, at: number | null) => ({
    id, at, event: { kind: 'tool' as const, toolCallId: id, name: 'Edit', title: 'a.ts', status: 'completed' as const, toolKind: 'edit' as const, rawInput: null },
});
const msg = (id: string, at: number | null) => ({
    id, at, event: { kind: 'message' as const, speaker: 'agent' as const, peerName: null, text: 'x' },
});
const divider = (id: string, at: number | null) => ({
    id, at, event: { kind: 'divider' as const, variant: 'compaction' as const, before: 189_000, after: 46_000 },
});

describe('a time RANGE in the route', () => {
    it('round-trips', () => {
        expect(formatRange({ from: 1_760_000_000_000, to: 1_760_000_040_000 })).toBe('1760000000000-1760000040000');
        expect(parseRange('1760000000000-1760000040000')).toEqual({ from: 1_760_000_000_000, to: 1_760_000_040_000 });
    });

    it('treats an ABSENT range as not filtering', () => {
        expect(parseRange(null)).toBeNull();
        expect(formatRange(null)).toBeNull();
    });

    it('DROPS a malformed range rather than failing the route', () => {
        // COUNTED: every malformed shape comes back null. A stale or hand-edited link must still
        // open the agent — a wider stream is recoverable, a blank surface is not.
        const bad = ['', 'abc', '12-', '-12', '12-abc', '40-10', '1e3-2e3', '12--14', '12-14-16', ' 12-14'];
        const accepted = bad.filter((v) => parseRange(v) !== null);
        expect(accepted).toEqual([]);
    });

    it('orders a reversed drag — a human can drag right-to-left', () => {
        // The parser refuses `40-10` (a link should be canonical); the DRAG produces it, and the
        // formatter is where it is normalised, so what reaches the route is always from <= to.
        expect(formatRange({ from: 40, to: 10 })).toBe('10-40');
    });
});

describe('the timeline — one tick per EDIT, placed by arrival time', () => {
    it('places every edit as a fraction of the span, and nothing else', () => {
        const rows = [msg('m1', 1000), edit('e1', 1000), msg('m2', 2000), edit('e2', 3000), edit('e3', 5000)];
        const t = timelineOf(rows);

        expect(t?.start).toBe(1000);
        expect(t?.end).toBe(5000);
        // COUNTED: three edits, three ticks; the two messages are not ticks.
        expect(t?.ticks.map((k) => [k.id, k.x])).toEqual([['e1', 0], ['e2', 0.5], ['e3', 1]]);
    });

    it('skips an edit with no time — it cannot be placed, and must not be placed at zero', () => {
        const t = timelineOf([edit('e1', 1000), edit('e-untimed', null), edit('e2', 3000)]);
        expect(t?.ticks.map((k) => k.id)).toEqual(['e1', 'e2']);
    });

    it('is null when there is no span to draw on', () => {
        // The sentence case and the all-untimed case both have no span; a tick "at 0..1 of
        // nothing" would be a lie about position.
        expect(timelineOf([])).toBeNull();
        expect(timelineOf([edit('e1', null)])).toBeNull();
    });

    it('a single instant still draws, with the tick in the middle', () => {
        // One timed row is a timeline of zero width. Rather than divide by zero or refuse, the
        // span is the instant and every tick sits at 0.5 — "it happened, here".
        const t = timelineOf([edit('e1', 1000)]);
        expect(t?.ticks).toEqual([{ id: 'e1', x: 0.5 }]);
    });

    it('turns a fraction back into a time, clamped, so a drag can become a range', () => {
        const t = timelineOf([edit('e1', 1000), edit('e2', 5000)]);
        expect(t && timeAt(t, 0)).toBe(1000);
        expect(t && timeAt(t, 0.25)).toBe(2000);
        expect(t && timeAt(t, 1)).toBe(5000);
        // A pointer released outside the bar is the edge, not a time off the span.
        expect(t && timeAt(t, -0.5)).toBe(1000);
        expect(t && timeAt(t, 1.5)).toBe(5000);
    });
});

describe('applying a range to the stream', () => {
    it('keeps rows inside the range, inclusive at both ends', () => {
        const rows = [msg('a', 1000), msg('b', 2000), msg('c', 3000), msg('d', 4000)];
        expect(rowsInRange(rows, { from: 2000, to: 3000 }).map((r) => r.id)).toEqual(['b', 'c']);
    });

    it('does not filter when there is no range', () => {
        const rows = [msg('a', 1000)];
        expect(rowsInRange(rows, null)).toBe(rows);
    });

    it('NEVER drops a compaction divider, whatever the range', () => {
        // The one rule that beats every filter: silent amnesia is the top cause of "why did it
        // get stupid", and a range that hid the moment it forgot would be the worst version.
        const rows = [msg('a', 1000), divider('cut', 9000), msg('b', 2000)];
        expect(rowsInRange(rows, { from: 1000, to: 2000 }).map((r) => r.id)).toEqual(['a', 'cut', 'b']);
    });

    it('drops a row with no time once a range is active — it cannot be placed in one', () => {
        // POSITIVE CONTROL beside it: the timed row inside the range stays.
        const rows = [msg('a', 1000), msg('untimed', null)];
        expect(rowsInRange(rows, { from: 0, to: 5000 }).map((r) => r.id)).toEqual(['a']);
    });
});

describe('E — the next edit after the current one', () => {
    const rows = [msg('m1', 1), edit('e1', 1), msg('m2', 1), edit('e2', 1), edit('e3', 1)];

    it('from nothing selected, goes to the first edit', () => {
        expect(nextEditAfter(rows, null)).toBe('e1');
    });

    it('from an edit, goes to the next edit, skipping everything between', () => {
        expect(nextEditAfter(rows, 'e1')).toBe('e2');
        expect(nextEditAfter(rows, 'e2')).toBe('e3');
    });

    it('from a non-edit row, goes to the next edit after IT', () => {
        expect(nextEditAfter(rows, 'm2')).toBe('e2');
    });

    it('from the last edit, WRAPS to the first — a key that does nothing at the end reads as broken', () => {
        expect(nextEditAfter(rows, 'e3')).toBe('e1');
    });

    it('is null when there are no edits at all — never a non-edit row', () => {
        expect(nextEditAfter([msg('m1', 1), msg('m2', 1)], null)).toBeNull();
        expect(nextEditAfter([msg('m1', 1), msg('m2', 1)], 'm1')).toBeNull();
    });
});

describe('a drag across the bar becomes a range', () => {
    const t = timelineOf([edit('e1', 1000), edit('e2', 5000)]);

    it('maps two fractions to times, in either order', () => {
        expect(t && rangeFromDrag(t, 0.25, 0.75)).toEqual({ from: 2000, to: 4000 });
        expect(t && rangeFromDrag(t, 0.75, 0.25)).toEqual({ from: 2000, to: 4000 });
    });

    it('clamps a drag that leaves the bar', () => {
        expect(t && rangeFromDrag(t, -1, 2)).toEqual({ from: 1000, to: 5000 });
    });

    it('a click is NOT a range — a mis-click must not filter the stream to nothing', () => {
        expect(t && rangeFromDrag(t, 0.4, 0.4)).toBeNull();
    });
});
