import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { STREAM_LIVE_ROWS } from '../src/core/stream-prep.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * FOLLOWING LIVE = THE LAST 500 ROWS (the owner, 2026-10-22). The Stream handed VirtualList every row of the ledger,
 * mapped through `ledgerRow` on every push. Following Live it now holds the last 500 activity rows; the rows behind them
 * are offered, and page in 500 at a time. A deep link (`at`) needs the row it names, so it gets the whole stream.
 */

const think = (i: number): TimedEvent => ({ id: `e${i}`, event: { kind: 'think', text: `thinking ${i}`, tokens: null }, at: 1_700_000_000_000 + i * 1000 });
const rows = (n: number) => Array.from({ length: n }, (_, i) => think(i));
const render = (r: readonly TimedEvent[], at: string | null = null) => renderToStaticMarkup(<Stream rows={r} lanes={null} at={at} selectedId={null} onSelect={() => {}} />);

describe('the Stream while Following Live', () => {
    it('3,000 activity rows: the last 500 are the list, and the 2,500 behind them are offered', () => {
        expect(STREAM_LIVE_ROWS).toBe(500);
        expect(render(rows(3000))).toMatch(/data-stream-earlier="2500"/);
    });

    it('a deep link gets the whole stream (the row it names may be anywhere): nothing is held back', () => {
        expect(render(rows(3000), 'e10')).not.toContain('data-stream-earlier');
    });

    it('CONTROL: a short stream is all there, and offers nothing earlier', () => {
        expect(render(rows(200))).not.toContain('data-stream-earlier');
    });
});
