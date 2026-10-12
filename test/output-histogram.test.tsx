import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BAR_HEIGHT_PX, OUTPUT_BARS, outputHistogram, outputTotalLabel } from '../src/core/observed.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE OUTPUT TIMELINE of an observed agent (the board's blind state): bytes out across the Take Over window's whole
 * life, in 24 bars from its start to now, and the total — from the host's byte counts, nothing invented. A window that
 * has printed nothing is all zeros and says `no output yet`.
 */
describe('outputHistogram', () => {
    it('buckets the bursts from the window’s start to now, scaled to the bar height; the peak bucket is the full bar', () => {
        const startedAt = 0;
        const now = 24_000; // 24 s → one second per bar
        const bars = outputHistogram([{ at: 500, bytes: 100 }, { at: 12_500, bytes: 400 }, { at: 12_900, bytes: 400 }, { at: 23_900, bytes: 200 }], startedAt, now);
        expect(bars).toHaveLength(OUTPUT_BARS);
        expect(bars[0]).toBe(Math.round((100 / 800) * BAR_HEIGHT_PX));
        expect(bars[12]).toBe(BAR_HEIGHT_PX);
        expect(bars[23]).toBe(Math.round((200 / 800) * BAR_HEIGHT_PX));
        expect(bars.filter((b) => b > 0)).toHaveLength(3);
    });

    it('all zeros with no output (a measured nothing), and a burst outside the window is not counted', () => {
        expect(outputHistogram([], 0, 24_000).every((b) => b === 0)).toBe(true);
        expect(outputHistogram([{ at: -5, bytes: 10 }, { at: 30_000, bytes: 10 }], 0, 24_000).every((b) => b === 0)).toBe(true);
    });

    it('the total label: bytes and the window’s life; `no output yet` without any', () => {
        expect(outputTotalLabel([{ at: 1, bytes: 12_100 }, { at: 2, bytes: 300 }], 0, 14 * 60_000)).toMatch(/^12\.\d kB over 14m$/);
        expect(outputTotalLabel([], 0, 60_000)).toBe('no output yet');
    });
});

describe('in the Activity tab', () => {
    const agent = { id: 'k1', name: 'kora', provider: 'claude', fidelity: 'observed' as const, cwd: '/w/tynn', instructions: null };
    const render = (bursts: { at: number; bytes: number }[]) =>
        renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="activity" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 60_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} takeOver={{ terminalId: 't1', startedAt: 0, lastOutputAt: bursts.at(-1)?.at ?? null, bursts }} />);

    it('draws the 24 bars and the total under the last-minute bars', () => {
        const html = render([{ at: 1_000, bytes: 2_048 }, { at: 50_000, bytes: 1_024 }]);
        expect((html.match(/data-output-bar="/g) ?? []).length).toBe(OUTPUT_BARS);
        expect(html).toMatch(/data-output-total=""[^>]*>3\.0 kB over 1m</);
    });

    it('says no output yet with none (positive control: the bars are there, all at the floor)', () => {
        const html = render([]);
        expect((html.match(/data-output-bar="/g) ?? []).length).toBe(OUTPUT_BARS);
        expect(html).toMatch(/data-output-total=""[^>]*>no output yet</);
    });
});
