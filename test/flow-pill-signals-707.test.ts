import { describe, expect, it } from 'vitest';
import { flowPillSignals, type PillFlow } from '../src/core/flow-pill-signals.js';

/** WHAT THE HOST REPORTS FOR THE HEADER'S FLOW PILLS (Tynn #707). */
const NOW = Date.parse('2026-11-14T12:00:00Z');
const iso = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
const flow = (id: string, extra: Partial<PillFlow> = {}): PillFlow => ({ id, workspaceId: 'w1', name: `Flow ${id}`, runs: [], ...extra });

describe('flowPillSignals', () => {
    it('a flow with a run in flight is live, with its name and workspace', () => {
        const out = flowPillSignals([flow('a', { inFlight: { at: iso(2000) } }), flow('b')], NOW);
        expect(out.flowsLive).toEqual([{ flowId: 'a', name: 'Flow a', workspaceId: 'w1', at: iso(2000) }]);
    });

    it('a latest run that failed or was held just now is reported ended; one that ran is not', () => {
        const out = flowPillSignals([
            flow('f', { runs: [{ outcome: 'failed', endedAt: iso(1000) }] }),
            flow('h', { runs: [{ outcome: 'held', endedAt: iso(1000) }] }),
            flow('r', { runs: [{ outcome: 'ran', endedAt: iso(1000) }] }),
        ], NOW);
        expect(out.flowsEnded.map((e) => [e.flowId, e.outcome])).toEqual([['f', 'failed'], ['h', 'held']]);
    });

    it('an old failure is not reported, and only the latest run counts', () => {
        const out = flowPillSignals([
            flow('old', { runs: [{ outcome: 'failed', endedAt: iso(60_000) }] }),
            flow('fixed', { runs: [{ outcome: 'failed', endedAt: iso(2000) }, { outcome: 'ran', endedAt: iso(1000) }] }),
        ], NOW);
        expect(out.flowsEnded).toEqual([]);
    });
});
