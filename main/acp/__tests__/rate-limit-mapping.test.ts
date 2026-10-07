import { describe, expect, it } from 'vitest';
import { META_RATE_LIMIT, META_UNMAPPED_FRAME } from '@particle-academy/prism-acp';
import { applySessionUpdate } from '../update-to-session';
import { emptyAgentSession } from '../../agentsession/model';
import { rateLimitSummary } from '../../agentsession/rate-limit';

/**
 * `notice` carried the rate-limit reading all along, and the mapper threw it away.
 *
 * Its own comment said why: *"Acknowledged, and deliberately unstored — the model has no
 * field for any of these yet."* Honest at the time, and it meant the one thing the owner
 * asked for — *"I do need to see what is remaining on rate limits at least"* — was arriving
 * on every turn and being discarded.
 *
 * Two keys are read, not one. Prism refuses an unrecognised payload TOTALLY and routes the
 * frame to `unmapped_frame` with a reason naming the field. Reading only `rate_limit` would
 * give "no gauge and no explanation" — their warning, and I would have walked into it.
 */

const NOW = 1_700_000_000_000;
const identity = {
    agentId: 'ag-1', specId: 'spec-1', provider: 'claude',
    name: 'kai', cwd: '/repo', workspaceId: 'ws-1',
};

/** A real frame, keyed as the provider keys it: `resetsAt` in SECONDS. */
const payload = {
    status: 'allowed',
    resetsAt: 1_791_260_400,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
    unifiedWindows: {
        five_hour: { utilization: 0.12, resetsAt: 1_791_260_400 },
        seven_day: { utilization: 0.32, resetsAt: 1_791_716_400 },
    },
};

const noticeUpdate = (meta: Record<string, unknown>) =>
    ({
        sessionUpdate: 'notice',
        notice: { level: 'warning', message: 'five_hour at 12%, resets 04:20' },
        _meta: meta,
    }) as never;

describe('a notice carrying a rate-limit reading', () => {
    it('lands on the session as a usable gauge', () => {
        const s = applySessionUpdate(emptyAgentSession(identity, NOW), noticeUpdate({ [META_RATE_LIMIT]: payload }), NOW);
        const summary = rateLimitSummary(s.rateLimit)!;
        expect(summary.binding!.name).toBe('five_hour');
        expect(summary.binding!.remaining).toBeCloseTo(0.88, 6);
    });

    it('converts the reset to MILLISECONDS, so it is not January 1970', () => {
        // The provider sends seconds in a field whose name gives no hint of its unit.
        const s = applySessionUpdate(emptyAgentSession(identity, NOW), noticeUpdate({ [META_RATE_LIMIT]: payload }), NOW);
        expect(s.rateLimit!.resetsAtMs).toBe(1_791_260_400_000);
        expect(new Date(s.rateLimit!.resetsAtMs).getUTCFullYear()).toBe(2026);
    });

    it('keeps the human sentence for display without keying on it', () => {
        const s = applySessionUpdate(emptyAgentSession(identity, NOW), noticeUpdate({ [META_RATE_LIMIT]: payload }), NOW);
        expect(s.rateLimit!.notice).toBe('five_hour at 12%, resets 04:20');
    });

    it('makes the session DECLARED, because no observer can produce this', () => {
        const s = applySessionUpdate(emptyAgentSession(identity, NOW), noticeUpdate({ [META_RATE_LIMIT]: payload }), NOW);
        expect(s.rateLimit).not.toBeNull();
    });
});

describe('an unrecognised payload', () => {
    it('stores the REASON, so a rename is explained rather than blank', () => {
        const s = applySessionUpdate(
            emptyAgentSession(identity, NOW),
            noticeUpdate({
                [META_UNMAPPED_FRAME]: {
                    reason: 'rate_limit: unifiedWindows.five_hour.utilization expected finite number >= 0, got null',
                    frame: {},
                },
            }),
            NOW,
        );
        expect(s.rateLimit).toBeNull();
        const summary = rateLimitSummary(s.rateLimit, { unrecognised: s.rateLimitUnavailable })!;
        expect(summary.unavailable).toMatch(/utilization/);
    });

    it('ignores an unmapped frame that is not about rate limits', () => {
        // `unmapped_frame` is a general channel — a frame with no mapping of any kind lands
        // there. Reporting "no gauge because <unrelated frame>" would be a false explanation.
        const s = applySessionUpdate(
            emptyAgentSession(identity, NOW),
            noticeUpdate({ [META_UNMAPPED_FRAME]: { reason: 'some other frame', frame: {} } }),
            NOW,
        );
        expect(s.rateLimitUnavailable).toBeNull();
    });
});

describe('a plain notice with no rate-limit meta', () => {
    it('changes nothing, as before', () => {
        const before = emptyAgentSession(identity, NOW);
        const s = applySessionUpdate(before, noticeUpdate({}), NOW);
        expect(s.rateLimit).toBeNull();
        expect(s.rateLimitUnavailable).toBeNull();
    });
});
