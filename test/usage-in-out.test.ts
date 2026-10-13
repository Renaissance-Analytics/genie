import { describe, expect, it } from 'vitest';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';
import { ledgerRow, resolveTurnCosts, type TimedEvent } from '../src/core/stream-view.js';

/**
 * THE USAGE ROW'S IN / OUT (the board: `+8.4k in · +1.1k out · context 182k / 200k · $0.61 this turn`). codex sends the
 * thread's running input and output totals on `usage_update._meta` (`inputTokens`, `outputTokens`); a turn's figures
 * are the rise from the previous report, the same rule as its cost. Claude sends no split (asked of prism-acp as
 * Particle-Academy/prism-acp-ts#3), so its rows carry none — absent, never `+0`.
 */
const usage = (meta: Record<string, unknown> | null) => ({ sessionUpdate: 'usage_update', used: 1000, size: 200_000, ...(meta ? { _meta: meta } : {}) });
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1 });

describe('the wire', () => {
    it('reads codex\'s running totals; a report without them has none (positive control)', () => {
        expect(toStreamEvent(usage({ inputTokens: 12_000, outputTokens: 3_000 }))).toMatchObject({ kind: 'usage', inTokens: 12_000, outTokens: 3_000 });
        expect(toStreamEvent(usage(null))).toMatchObject({ kind: 'usage', inTokens: null, outTokens: null });
    });
});

describe('the row', () => {
    it('a turn\'s in and out are the rise from the previous report; the first is its own; none sent, none shown', () => {
        const rows = resolveTurnCosts([
            t('u1', toStreamEvent(usage({ inputTokens: 3_600, outputTokens: 400 }))!),
            t('u2', toStreamEvent(usage({ inputTokens: 12_000, outputTokens: 1_500 }))!),
            t('u3', toStreamEvent(usage(null))!),
        ]);
        expect(ledgerRow(rows[0]!).main).toBe('+3.6k in · +400 out · context 1k / 200k');
        expect(ledgerRow(rows[1]!).main).toBe('+8.4k in · +1.1k out · context 1k / 200k');
        expect(ledgerRow(rows[2]!).main).toBe('context 1k / 200k');
    });
});
