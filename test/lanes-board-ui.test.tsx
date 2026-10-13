import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { Lanes } from '../src/renderer/components/Lanes.js';

/**
 * THE DRAWER ON SCREEN (the board): the header `LANES` with the span and the hint, four labelled tracks with their
 * blocks (the edits track's blocks are the ticks the timeline tests count), the selection label while a range is set,
 * the time axis under the tracks. The drag still covers the whole group.
 */
const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
const tool = (name: string, toolKind: 'edit' | 'execute'): StreamEvent => ({ kind: 'tool', toolCallId: name, name, title: null, status: 'completed', toolKind, rawInput: null });
const T0 = Date.UTC(2026, 9, 12, 14, 2, 0);
const rows: TimedEvent[] = [
    t('t14', { kind: 'turn', n: 14, by: 'you' }, T0),
    t('m1', { kind: 'message', speaker: 'you', peerName: null, text: 'go' }, T0 + 60_000),
    t('k1', { kind: 'think', text: 'hmm', tokens: null }, T0 + 120_000),
    t('b1', tool('Bash', 'execute'), T0 + 180_000),
    t('e1', tool('Edit', 'edit'), T0 + 240_000),
];
const render = (range: { from: number; to: number } | null) =>
    renderToStaticMarkup(<Lanes rows={rows} range={range} onRange={() => {}} now={() => T0 + 250_000} />);

describe('the lanes drawer', () => {
    it('header with the span and the hint; four labelled tracks with blocks; the axis', () => {
        const html = render(null);
        expect(html).toMatch(/data-lanes-span[^>]*>[^<]*Turn 14 · \d{2}:\d{2} – now/);
        expect(html).toContain('Drag across the lanes to select a range');
        // Three activity tracks: replies live in the chat, so there is no messages track.
        for (const lane of ['thoughts', 'tools', 'edits']) expect(html).toContain(`data-lane-track="${lane}"`);
        expect(html).not.toContain('data-lane-track="messages"');
        expect(html).toMatch(/data-lane-track="thoughts"[\s\S]*?data-lane-block="k1"/);
        expect(html).toMatch(/data-lane-track="edits"[\s\S]*?data-tick="e1"/);
        expect((html.match(/data-axis-tick/g) ?? []).length).toBe(5);
        expect(html).not.toContain('data-lanes-selected');
    });

    it('a range: the selection label with its count', () => {
        const html = render({ from: T0 + 100_000, to: T0 + 200_000 });
        expect(html).toMatch(/data-lanes-selected[^>]*>[^<]*selected \d{2}:\d{2}:\d{2} – \d{2}:\d{2}:\d{2} · 2 events/);
        expect(html).toContain('data-range-band="set"');
    });
});
