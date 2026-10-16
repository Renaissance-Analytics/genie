import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import { ledgerRow, resolveTurnCosts, sessionCostOf, type TimedEvent } from '../src/core/stream-view.js';

/**
 * WHAT A TURN COST, AND WHAT THE SESSION COST (the board: `$0.61 this turn` on the usage row, `$4.12 this session` in
 * the rail). ACP's `usage_update.cost` is the session's RUNNING total — prism-acp passes Claude's `total_cost_usd`,
 * which in streaming-input mode "carr[ies] the running total for the whole call so far" plus any spend restored on
 * resume (Agent SDK, Track cost and usage). Genie labelled that running total "this turn" and showed no session cost
 * at all (main hard-coded `cost: null`). Now: a turn's cost is the rise from the previous report (the first report
 * of a thread is its own rise); a fall — a `/clear`, or an older CLI that restarted its totals — says nothing about
 * that turn, so no figure; the session's cost is the latest report. codex reports none: no figure anywhere.
 */
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1 });
const usage = (id: string, cost: number | null): TimedEvent => t(id, { kind: 'usage', used: 1000, size: 200_000, cost });
const turnCostOf = (rows: readonly TimedEvent[], id: string) => {
    const e = rows.find((r) => r.id === id)!.event;
    return e.kind === 'usage' ? e.turnCost : undefined;
};

describe('resolveTurnCosts', () => {
    it('each report minus the one before; the first is its own; a fall gives none; a report without cost has none', () => {
        const rows = resolveTurnCosts([usage('u1', 0.25), t('m', { kind: 'message', speaker: 'agent', peerName: null, text: 'ok' }), usage('u2', 0.86), usage('u3', 0.1), usage('u4', null), usage('u5', 0.4)]);
        expect(turnCostOf(rows, 'u1')).toBeCloseTo(0.25);
        expect(turnCostOf(rows, 'u2')).toBeCloseTo(0.61);
        expect(turnCostOf(rows, 'u3')).toBeNull();
        expect(turnCostOf(rows, 'u4')).toBeNull();
        expect(turnCostOf(rows, 'u5')).toBeCloseTo(0.3);
    });
});

describe('the usage row', () => {
    it('reads the turn\'s own cost, never the running total', () => {
        const [, second] = resolveTurnCosts([usage('u1', 3.51), usage('u2', 4.12)]);
        expect(ledgerRow(second!).main).toBe('context 1k / 200k · $0.61 this turn');
    });

    it('an unresolved report shows no cost rather than the running total under the wrong name (positive control above)', () => {
        expect(ledgerRow(usage('u1', 4.12)).main).toBe('context 1k / 200k');
    });
});

describe('sessionCostOf', () => {
    it('the latest report\'s running total; none reported is null, never 0', () => {
        expect(sessionCostOf([usage('u1', 3.51), usage('u2', 4.12), usage('u3', null)])).toBeCloseTo(4.12);
        expect(sessionCostOf([usage('u1', null)])).toBeNull();
        expect(sessionCostOf([])).toBeNull();
    });
});
