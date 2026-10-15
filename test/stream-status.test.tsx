import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chipRow } from '../src/core/session-timeline.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { Stream } from '../src/renderer/components/Stream.js';
import { ChipsRow } from '../src/renderer/components/TimelineStrip.js';

/**
 * TWO LAYOUT FIXES the owner pointed at (2026-10-14):
 *   - "move the `Following live` pill at the bottom of the agent stream into a status bar under the stream": floating
 *     bottom-right it covered the newest row's text and the scrollbar;
 *   - the chips row ran under the right column and cut the find box off.
 */
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Bash', title: 'ls', status: 'completed', toolKind: 'execute', rawInput: { command: 'ls' } }),
];
const stream = (at: string | null) => renderToStaticMarkup(<Stream rows={rows} lanes={null} at={at} selectedId={null} onSelect={() => {}} agentName="sable" />);

describe('the follow pill sits in a status bar under the stream', () => {
    it('LIVE: inside the status bar, which comes AFTER the rows, and is not positioned over them', () => {
        const html = stream(null);
        const bar = html.indexOf('data-stream-status');
        expect(bar).toBeGreaterThan(-1);
        expect(html.indexOf('data-follow="live"')).toBeGreaterThan(bar);
        // COUNTED: nothing in the Stream is absolutely positioned at the bottom-right any more.
        expect(html.match(/absolute bottom-3 right-3/g) ?? []).toHaveLength(0);
        expect(html).toMatch(/data-stream-status=""[^>]*class="[^"]*shrink-0[^"]*border-t/);
    });

    it('PARKED: the same bar holds the button back to the tail', () => {
        const html = stream('a1:1');
        expect(html.indexOf('data-follow="parked"')).toBeGreaterThan(html.indexOf('data-stream-status'));
    });

    it('POSITIVE CONTROL: an empty Stream draws no bar and no pill', () => {
        const html = renderToStaticMarkup(<Stream rows={[]} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="sable" />);
        expect(html).not.toContain('data-stream-status');
        expect(html).not.toContain('data-follow=');
    });
});

describe('the chips row never pushes the find box out of view', () => {
    it('the chips scroll in their own lane; the find box sits outside it and never shrinks', () => {
        const html = renderToStaticMarkup(<ChipsRow chips={chipRow(rows, null)} selected={null} onChange={() => {}} />);
        expect(html).toMatch(/data-chips=""[^>]*class="[^"]*min-w-0/);
        expect(html).toMatch(/data-chip-lane=""[^>]*class="[^"]*min-w-0[^"]*flex-1[^"]*overflow-x-auto/);
        const laneEnd = html.indexOf('data-find-box');
        expect(laneEnd).toBeGreaterThan(html.indexOf('data-chip-lane'));
        expect(html).toMatch(/data-find-box=""[^>]*class="[^"]*shrink-0/);
        // Every chip keeps its width inside the lane (it scrolls rather than squashes).
        const chips = html.match(/<button[^>]*class="flex h-6 [^"]*"/g) ?? [];
        expect(chips.length).toBeGreaterThan(0);
        expect(chips.filter((c) => !c.includes('shrink-0'))).toHaveLength(0);
    });
});
