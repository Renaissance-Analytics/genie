import { describe, expect, it } from 'vitest';
import { headroomDisplay, windowLabel } from '../rate-limit-view';
import type { RateLimitSummary, WindowHeadroom } from '../../../main/agentsession/rate-limit-headroom';

/**
 * THE ONE NUMBER THE OWNER ASKED TO SEE.
 *
 * > *"gain/loss comparison is not part of the app. I will measure this myself based on the
 * > amount of work I can do before hitting rate limits on subscriptions. I do need to see what
 * > is remaining on rate limits at least."*
 *
 * `main/agentsession/rate-limit.ts` computes the headroom and is tested. Nothing RENDERED it:
 * `rateLimit` reached the session model, the renderer's types and an e2e fixture, and no
 * surface in the product read it. So the measurement the owner intends to judge this migration
 * by was invisible — which is the kind of gap a green suite reports as done.
 *
 * This is the display decision, kept pure because the renderer's test environment has no DOM
 * and a decision made inside a component is a decision nobody checks.
 *
 * ## What it must not do
 *
 * Invent a reading. A pty agent will never report one, and `null` there means CANNOT SEE — so
 * the surface renders nothing rather than full headroom. Showing "100% left" for an agent
 * nobody is metering is the single most expensive thing this could get wrong: it is exactly
 * the number somebody plans a day's work around.
 */

const win = (over: Partial<WindowHeadroom> = {}): WindowHeadroom => ({
    name: 'five_hour',
    remaining: 0.87,
    utilization: 0.13,
    overspent: false,
    resetsAtMs: 3_600_000,
    ...over,
});

const summary = (over: Partial<RateLimitSummary> = {}): RateLimitSummary => ({
    allowed: true,
    binding: win(),
    windows: [win()],
    usingOverage: false,
    overageStatus: null,
    notice: null,
    unavailable: null,
    ...over,
});

const NOW = 0;

describe('headroomDisplay', () => {
    it('renders NOTHING when there is no reading and no explanation', () => {
        // The normal state of every pty agent. Full headroom would be a fabrication.
        expect(headroomDisplay(null, NOW)).toBeNull();
    });

    it('leads with what is LEFT, not what is used', () => {
        const d = headroomDisplay(summary(), NOW)!;
        expect(d.headline).toBe('87% left');
        expect(d.barPercent).toBe(87);
        expect(d.tone).toBe('ok');
    });

    it('names the window the provider says will stop you first', () => {
        expect(headroomDisplay(summary(), NOW)!.bindingLabel).toBe('5h');
    });

    it('says when the window resets, relatively', () => {
        // Relative because it answers the question actually being asked — "how long until I can
        // work again" — and because an absolute clock needs a timezone this layer has no business
        // choosing.
        expect(headroomDisplay(summary(), NOW)!.resetsLabel).toBe('resets in 1h');
        expect(
            headroomDisplay(summary({ binding: win({ resetsAtMs: 42 * 60_000 }) }), NOW)!.resetsLabel,
        ).toBe('resets in 42m');
        expect(
            headroomDisplay(summary({ binding: win({ resetsAtMs: 90 * 60_000 }) }), NOW)!.resetsLabel,
        ).toBe('resets in 1h 30m');
    });

    it('says "resets any moment" rather than a negative duration', () => {
        // The reset time passes between frames. "resets in -3m" is the kind of detail that makes
        // a reader distrust every other number on the screen.
        expect(
            headroomDisplay(summary({ binding: win({ resetsAtMs: 1000 }) }), 60_000)!.resetsLabel,
        ).toBe('resets any moment');
    });

    it('WARNS before the wall, not at it', () => {
        // The point of a gauge is to change what you do next, which needs to happen while there
        // is still something left to spend.
        expect(headroomDisplay(summary({ binding: win({ remaining: 0.15, utilization: 0.85 }) }), NOW)!.tone)
            .toBe('warn');
        expect(headroomDisplay(summary({ binding: win({ remaining: 0.16, utilization: 0.84 }) }), NOW)!.tone)
            .toBe('ok');
    });

    it('distinguishes EXHAUSTED from OVERSPENT, because the provider does', () => {
        // `utilization` can exceed 1 — the provider models overage — so "empty" and "past your
        // allowance" are different states and only one of them is costing money.
        const empty = headroomDisplay(summary({ binding: win({ remaining: 0, utilization: 1 }) }), NOW)!;
        expect(empty.tone).toBe('empty');
        expect(empty.headline).toBe('0% left');

        const over = headroomDisplay(
            summary({ binding: win({ remaining: 0, utilization: 1.4, overspent: true }), usingOverage: true }),
            NOW,
        )!;
        expect(over.tone).toBe('over');
        expect(over.headline).toBe('140% used — into overage');
    });

    it('reports a REFUSAL above any headroom figure', () => {
        // `allowed: false` is the provider saying no right now. A cheerful percentage beside a
        // refusal reads as a bug in Genie rather than a limit on the account.
        const d = headroomDisplay(summary({ allowed: false }), NOW)!;
        expect(d.tone).toBe('blocked');
        expect(d.headline).toBe('rate limited');
        // The headroom is still carried, because "limited, and it clears in 1h" is the useful
        // sentence.
        expect(d.resetsLabel).toBe('resets in 1h');
    });

    it('shows WHY there is no reading when that is all there is', () => {
        // Prism refuses a payload with an unrecognised field outright and routes the frame to
        // `unmapped_frame`. Their own warning is that reading only `rate_limit` leaves "no gauge
        // and no explanation" — so the explanation is the surface.
        const d = headroomDisplay(
            summary({ binding: null, windows: [], unavailable: 'unmapped frame: rate_limit_event' }),
            NOW,
        )!;
        expect(d.tone).toBe('unknown');
        expect(d.barPercent).toBeNull();
        expect(d.headline).toBe('no reading');
        expect(d.note).toBe('unmapped frame: rate_limit_event');
    });

    it('carries EVERY window, because they disagree and both matter', () => {
        // A 5-hour window with room and a 7-day one nearly gone is the case where only one
        // number is actively misleading.
        const d = headroomDisplay(
            summary({
                binding: win({ name: 'seven_day', remaining: 0.04, utilization: 0.96 }),
                windows: [win(), win({ name: 'seven_day', remaining: 0.04, utilization: 0.96 })],
            }),
            NOW,
        )!;
        expect(d.windows.map((w) => w.label)).toEqual(['5h', '7d']);
        expect(d.windows.map((w) => w.percentLeft)).toEqual([87, 4]);
        expect(d.bindingLabel).toBe('7d');
    });

    it('passes the provider notice through as a note, and never keys on it', () => {
        // Prism has changed that text once already and says it is deliberately unstable.
        expect(headroomDisplay(summary({ notice: 'Approaching your limit' }), NOW)!.note).toBe(
            'Approaching your limit',
        );
    });

    it('prefers a real reading to a stale explanation', () => {
        const d = headroomDisplay(summary({ unavailable: 'something odd' }), NOW)!;
        expect(d.headline).toBe('87% left');
    });
});

describe('windowLabel', () => {
    it('shortens the windows the provider actually sends', () => {
        expect(windowLabel('five_hour')).toBe('5h');
        expect(windowLabel('seven_day')).toBe('7d');
    });

    it('falls back to a readable form of an unknown key', () => {
        // The provider can add a window and a key we have never seen must still be legible. A
        // thrown error or a blank label would hide a limit that is real.
        expect(windowLabel('thirty_day')).toBe('thirty day');
        expect(windowLabel('')).toBe('limit');
    });
});
