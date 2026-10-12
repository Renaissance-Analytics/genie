import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { contextNote } from '../src/core/agent-view.js';

/**
 * THE RIGHT COLUMN'S CONTEXT NOTE (the board, under the context bar): `Compaction expected near 190k. Consider a
 * handoff before step 5.` while the context is high; `Compacted at 14:20 from 189k → 46k` after a compaction;
 * `Last reported at 14:21. Nothing since the stream closed.` when the session broke. Each from facts on the wire —
 * the usage and compaction rows carry their times — and `null` (absent) when none applies.
 */
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: 0, pendingApproval: null, failure: null, contextUsed: 38_000, contextSize: 200_000, plan: null, ...over,
} as LiveSession);
const at = (h: number, m: number) => new Date(2026, 9, 12, h, m).getTime();
const usage = (id: string, used: number, t: number): TimedEvent => ({ id, at: t, event: { kind: 'usage', used, size: 200_000, cost: null } });
const compaction = (id: string, before: number, after: number, t: number): TimedEvent => ({ id, at: t, event: { kind: 'divider', variant: 'compaction', before, after } });
const fmt = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

describe('contextNote', () => {
    it('warns when the context is high, naming where compaction is expected and the next plan step', () => {
        expect(contextNote(session({ contextUsed: 182_000, plan: { step: 4, of: 7, doing: 'x' } }), [], 'ok')).toEqual({ text: 'Compaction expected near 190k. Consider a handoff before step 5.', tone: 'warn' });
        expect(contextNote(session({ contextUsed: 182_000 }), [], 'ok')).toEqual({ text: 'Compaction expected near 190k.', tone: 'warn' });
    });

    it('reports the last compaction with its time and sizes, when the context is not high', () => {
        const rows = [compaction('c1', 189_000, 46_000, at(14, 20)), usage('u1', 50_000, at(14, 21))];
        expect(contextNote(session({ contextUsed: 50_000 }), rows, 'ok')).toEqual({ text: `Compacted at ${fmt(at(14, 20))} from 189k → 46k`, tone: 'muted' });
    });

    it('a broken session: when usage was last reported, and that nothing came after', () => {
        const rows = [usage('u1', 120_000, at(14, 21))];
        expect(contextNote(session({ failure: { reason: 'stream closed', fixes: [] }, running: false, turnState: 'failed' }), rows, 'bad')).toEqual({ text: `Last reported at ${fmt(at(14, 21))}. Nothing since the stream closed.`, tone: 'bad' });
        // Broken with NO usage row ever: no time to claim.
        expect(contextNote(session({ failure: { reason: 'x', fixes: [] } }), [], 'bad')).toEqual({ text: 'Nothing was reported before the stream closed.', tone: 'bad' });
    });

    it('nothing to say → null, not a filler sentence; no session → null', () => {
        expect(contextNote(session(), [], 'ok')).toBeNull();
        expect(contextNote(null, [], 'ok')).toBeNull();
    });
});
