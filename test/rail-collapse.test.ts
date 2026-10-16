import { describe, expect, it } from 'vitest';
import { railMode, railSummary, RAIL_COLLAPSE_BELOW } from '../src/core/agent-view.js';
import type { LiveSession } from '../src/core/roster.js';

/**
 * THE RIGHT COLUMN COLLAPSES BELOW ~1100px OF CONTENT WIDTH (§4.2) into a 32px summary strip — `3/6 · 89% ctx · ⚠`
 * — **width-triggered, never state-triggered**: a rail that collapsed because a number went missing would move the
 * conversation sideways mid-turn. An unmeasured width (server-side, first paint) is the full column.
 */
const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: 178_000, contextSize: 200_000, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: { step: 3, of: 6, doing: 'x' }, ...over }) as LiveSession;

describe('railMode', () => {
    it('full at and above the threshold, strip below it; unmeasured is full', () => {
        expect(RAIL_COLLAPSE_BELOW).toBe(1100);
        expect(railMode(1100)).toBe('full');
        expect(railMode(1440)).toBe('full');
        expect(railMode(1099)).toBe('strip');
        expect(railMode(800)).toBe('strip');
        expect(railMode(null)).toBe('full');
    });
});

describe('railSummary', () => {
    it('the plan, the context pressure, and a warning mark when the note has one — only the parts that exist', () => {
        expect(railSummary(session(), 'warn')).toBe('3/6 · 89% ctx · ⚠');
        expect(railSummary(session(), 'ok')).toBe('3/6 · 89% ctx');
        expect(railSummary(session({ plan: null }), 'ok')).toBe('89% ctx');
        expect(railSummary(session({ contextUsed: null, contextSize: null }), 'ok')).toBe('3/6');
    });

    it('nothing to say → null (the strip is not drawn as an empty bar)', () => {
        expect(railSummary(session({ plan: null, contextUsed: null, contextSize: null }), 'ok')).toBeNull();
        expect(railSummary(null, 'ok')).toBeNull();
    });
});
