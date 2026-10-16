import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Lanes } from '../src/renderer/components/Lanes.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE TIMELINE'S MARKUP — ticks for edits, a band for the active range.
 *
 * `react-dom/server`, no browser. The drag itself is pointer events and cannot be exercised
 * here; what it produces is proven in `lanes-range.test.ts` (`rangeFromDrag`). This file pins
 * what a reader sees: how many ticks, where, and whether a range is shown — as COUNTS.
 */

const edit = (id: string, at: number | null): TimedEvent => ({
    id, at, event: { kind: 'tool', toolCallId: id, name: 'Edit', title: 'a.ts', status: 'completed', toolKind: 'edit', rawInput: null },
});
const msg = (id: string, at: number | null): TimedEvent => ({
    id, at, event: { kind: 'message', speaker: 'agent', peerName: null, text: 'x' },
});

const render = (rows: readonly TimedEvent[], range: { from: number; to: number } | null = null) =>
    renderToStaticMarkup(<Lanes rows={rows} range={range} onRange={() => {}} />);

describe('ticks', () => {
    it('draws one tick per edit, COUNTED, and none for other rows', () => {
        const html = render([msg('m1', 1000), edit('e1', 1000), msg('m2', 2000), edit('e2', 3000), edit('e3', 5000)]);
        expect(html.match(/data-tick="/g)?.length ?? 0).toBe(3);
        expect(html).toContain('data-tick="e1"');
        expect(html).not.toContain('data-tick="m1"');
    });

    it('places them by fraction of the span', () => {
        const html = render([edit('e1', 1000), edit('e2', 3000), edit('e3', 5000)]);
        expect(html).toMatch(/data-tick="e1"[^>]*left:0%/);
        expect(html).toMatch(/data-tick="e2"[^>]*left:50%/);
        expect(html).toMatch(/data-tick="e3"[^>]*left:100%/);
    });

    it('draws the bar with NO ticks when there are rows but no edits — a measured none', () => {
        // POSITIVE CONTROL for the count above, in the other direction: the timeline is drawn
        // (rows are timed), and it is honestly empty of ticks.
        const html = render([msg('m1', 1000), msg('m2', 2000)]);
        expect(html).toContain('data-lanes-timeline');
        expect(html.match(/data-tick="/g)?.length ?? 0).toBe(0);
    });
});

describe('the range band', () => {
    const rows = [edit('e1', 1000), edit('e2', 5000)];

    it('is absent with no range', () => {
        expect(render(rows)).not.toContain('data-range-band');
    });

    it('spans the selected fraction of the bar, and offers a way to clear it', () => {
        const html = render(rows, { from: 2000, to: 4000 });
        expect(html).toMatch(/data-range-band[^>]*left:25%[^>]*width:50%/);
        expect(html).toContain('data-range-clear');
    });

    it('is clamped to the bar when the range runs past the span', () => {
        // A range from a link to an older, longer turn: shown as far as it applies, never drawn
        // off the edge of the bar.
        const html = render(rows, { from: 0, to: 9000 });
        expect(html).toMatch(/data-range-band[^>]*left:0%[^>]*width:100%/);
    });
});
