import { describe, expect, it } from 'vitest';
import { drawerLabels, laneTracks, timelineOf } from '../src/core/lanes.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE LANES DRAWER PER THE BOARD: four TRACKS (Messages / Thoughts / Tools / Edits), each with a block per event
 * placed by its time; a span label (`Turn 14 · 14:02 – now`); the selection label (`selected 14:07:40 – 14:09:00 ·
 * 31 events`) while a range is set; a time axis under the tracks. Every figure from the rows' own times.
 */
const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const tool = (name: string, toolKind: 'edit' | 'execute'): StreamEvent => ({ kind: 'tool', toolCallId: name, name, title: null, status: 'completed', toolKind, rawInput: null });
const T0 = Date.UTC(2026, 9, 12, 14, 2, 0);
const rows: TimedEvent[] = [
    t('t14', { kind: 'turn', n: 14, by: 'you' }, T0),
    t('m1', { kind: 'message', speaker: 'you', peerName: null, text: 'go' }, T0 + 60_000),
    t('k1', { kind: 'think', text: 'hmm', tokens: null }, T0 + 120_000),
    t('b1', tool('Bash', 'execute'), T0 + 180_000),
    t('e1', tool('Edit', 'edit'), T0 + 240_000),
    t('m2', { kind: 'message', speaker: 'agent', peerName: null, text: 'done' }, T0 + 300_000),
];
const timeline = timelineOf(rows)!;

describe('laneTracks', () => {
    it('one block per event in its lane, placed by the fraction of the span; untimed rows and structure rows draw none', () => {
        const tracks = laneTracks(rows, timeline);
        expect(tracks.map((tr) => tr.lane)).toEqual(['thoughts', 'tools', 'edits']);
        // The messages m1 / m2 are the chat's: no track draws them.
        expect(tracks[0]!.blocks).toEqual([{ id: 'k1', x: 0.4 }]);
        expect(tracks[1]!.blocks).toEqual([{ id: 'b1', x: 0.6 }]);
        expect(tracks[2]!.blocks).toEqual([{ id: 'e1', x: 0.8 }]);
    });
});

describe('drawerLabels', () => {
    it('the span names the latest turn and runs from the first time to `now` while the end is recent', () => {
        const labels = drawerLabels(rows, timeline, null, T0 + 300_000 + 20_000);
        expect(labels.span).toMatch(/^Turn 14 · \d{2}:\d{2} – now$/);
        expect(labels.selected).toBeNull();
        expect(labels.axis).toHaveLength(5);
        expect(labels.axis.at(-1)).toBe('now');
        expect(labels.axis[0]).toMatch(/^\d{2}:\d{2}$/);
    });

    it('an end that is not recent is a clock, not `now`; without a turn marker the span is the times alone', () => {
        const old = drawerLabels(rows, timeline, null, T0 + 3 * 3_600_000);
        expect(old.span).toMatch(/^Turn 14 · \d{2}:\d{2} – \d{2}:\d{2}$/);
        expect(old.axis.at(-1)).toMatch(/^\d{2}:\d{2}$/);
        const noTurn = drawerLabels(rows.filter((r) => r.event.kind !== 'turn'), timeline, null, T0 + 3 * 3_600_000);
        expect(noTurn.span).toMatch(/^\d{2}:\d{2} – \d{2}:\d{2}$/);
    });

    it('a range is said with its clocks and the count of rows inside it', () => {
        const labels = drawerLabels(rows, timeline, { from: T0 + 100_000, to: T0 + 250_000 }, T0 + 320_000);
        expect(labels.selected).toMatch(/^selected \d{2}:\d{2}:\d{2} – \d{2}:\d{2}:\d{2} · 3 events$/);
    });
});
