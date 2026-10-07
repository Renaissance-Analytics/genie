import { describe, expect, it } from 'vitest';
import { windowHeadroom, bindingWindow, rateLimitSummary, type SessionRateLimit } from '../rate-limit';

/**
 * Subscription headroom — "how much work can I do before I hit the wall".
 *
 * Owner requirement, verbatim: *"I will measure this myself based on the amount of work I can
 * do before hitting rate limits on subscriptions. I do need to see what is remaining on rate
 * limits at least."*
 *
 * ## It is a gauge, and that was measured rather than assumed
 *
 * Prism holds three independently captured turns (`prism-acp-ts/test/fixtures/*.ndjson`), each
 * carrying one `rate_limit_event`. In all three `status` is `"allowed"`, the frame lands about
 * a quarter of the way into the stream, and `five_hour.utilization` reads 0.10, 0.12, 0.13 —
 * it moves with work done. So this is not a breach notification; it is a live meter, and the
 * honest surface is a gauge.
 *
 * ## Two things here would have shipped wrong
 *
 * **`resetsAt` is epoch SECONDS.** `1791260400` read as milliseconds is January 1970. Prism
 * converts once and names the field for its unit (`resetsAtMs`); nothing here multiplies by
 * 1000 on a hunch.
 *
 * **`utilization` can exceed 1.** The provider models overage — `isUsingOverage`,
 * `overageStatus` — so a window consumed past its allowance is a real state, and
 * `1 - utilization` goes negative. Clamping is for the BAR, never for the number: a bar pinned
 * at empty beside "running on overage" is the true picture, and it is only distinguishable
 * from "0% left" if both are kept.
 */

const limit = (over: Partial<SessionRateLimit> = {}): SessionRateLimit => ({
    status: 'allowed',
    resetsAtMs: 1_791_260_400_000,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
    windows: {
        five_hour: { utilization: 0.12, resetsAtMs: 1_791_260_400_000 },
        seven_day: { utilization: 0.32, resetsAtMs: 1_791_716_400_000 },
    },
    notice: 'five_hour at 12%, resets 04:20',
    // Required on the package's type, and deliberately so: a field the provider ADDS still
    // reaches a consumer through `raw` even though the declared type does not name it yet.
    raw: {},
    ...over,
});

describe('windowHeadroom', () => {
    it('is the fraction left — 1 minus what has been consumed', () => {
        expect(windowHeadroom({ utilization: 0.12, resetsAtMs: 0 })).toMatchObject({
            remaining: 0.88,
            overspent: false,
        });
    });

    it('CLAMPS the bar at empty under overage, and keeps the real figure', () => {
        // The correction Prism sent before I wrote a line. `1 - 1.4` is -0.4; a bar cannot
        // render that, and rounding it to 0 silently would lose the fact that the window is
        // not merely full but exceeded.
        const h = windowHeadroom({ utilization: 1.4, resetsAtMs: 0 });
        expect(h.remaining).toBe(0);
        expect(h.utilization).toBe(1.4);
        expect(h.overspent).toBe(true);
    });

    it('distinguishes exactly-full from overspent', () => {
        // Both render an empty bar. Only one of them means "you are past your allowance",
        // and a surface that cannot tell them apart cannot explain itself.
        expect(windowHeadroom({ utilization: 1, resetsAtMs: 0 })).toMatchObject({
            remaining: 0,
            overspent: false,
        });
    });

    it('is full headroom for an untouched window', () => {
        expect(windowHeadroom({ utilization: 0, resetsAtMs: 0 }).remaining).toBe(1);
    });
});

describe('bindingWindow', () => {
    it('is the window the provider says is binding', () => {
        // `rateLimitType` is the provider's own answer to "which limit will stop you first".
        // Picking the lowest-headroom window ourselves would be a guess that disagrees with
        // the thing enforcing it.
        expect(bindingWindow(limit())?.name).toBe('five_hour');
    });

    it('falls back to the WORST window when the named one is absent', () => {
        // Defensive rather than clever: if `rateLimitType` names something not in `windows`,
        // reporting nothing would hide a real limit, and reporting the first key would be
        // arbitrary. The tightest window is the honest answer to "what stops me first".
        const l = limit({ rateLimitType: 'something_new' });
        expect(bindingWindow(l)?.name).toBe('seven_day');
    });

    it('is null when there are no windows at all', () => {
        expect(bindingWindow(limit({ windows: {} }))).toBeNull();
    });
});

describe('rateLimitSummary — what a surface renders', () => {
    it('leads with the binding window and reports every window', () => {
        const s = rateLimitSummary(limit());
        expect(s).not.toBeNull();
        expect(s!.binding!.name).toBe('five_hour');
        expect(s!.binding!.remaining).toBeCloseTo(0.88, 6);
        expect(s!.windows.map((w) => w.name).sort()).toEqual(['five_hour', 'seven_day']);
    });

    it('shows BOTH windows, because they disagree and both matter', () => {
        // Prism's point: the 5h window can be at 12% while the 7d is at 32%. Showing only
        // the binding one hides the fact that a week of this pace runs out sooner.
        const s = rateLimitSummary(limit())!;
        const seven = s.windows.find((w) => w.name === 'seven_day')!;
        expect(seven.remaining).toBeCloseTo(0.68, 6);
    });

    it('reports NOT ALLOWED without matching a breach spelling', () => {
        // Prism has never captured a breached frame, so the spelling of a non-allowed status
        // is unknown and the type is deliberately an open union. Matching a guess would fail
        // on the first real breach — the exact inverse of the bug we are avoiding.
        expect(rateLimitSummary(limit({ status: 'exceeded' }))!.allowed).toBe(false);
        expect(rateLimitSummary(limit({ status: 'anything_at_all' }))!.allowed).toBe(false);
        expect(rateLimitSummary(limit({ status: 'allowed' }))!.allowed).toBe(true);
    });

    it('surfaces overage as its own fact, not as zero headroom', () => {
        const s = rateLimitSummary(
            limit({
                isUsingOverage: true,
                overageStatus: 'rejected',
                windows: { five_hour: { utilization: 1.2, resetsAtMs: 0 } },
            }),
        )!;
        expect(s.usingOverage).toBe(true);
        expect(s.binding!.overspent).toBe(true);
        expect(s.overageStatus).toBe('rejected');
    });

    it('carries the provider notice for display but nothing keys on it', () => {
        // Prism changed this text once already and says it is deliberately unstable. It is
        // for a human to read; the structured half is what decides anything.
        expect(rateLimitSummary(limit({ notice: 'whatever they write next' }))!.notice).toBe(
            'whatever they write next',
        );
    });

    it('is null when nothing has been reported', () => {
        // "Cannot see" — the agent has not sent a rate-limit frame yet, or is a pty agent
        // that never will. A surface must render nothing, not 100% headroom.
        expect(rateLimitSummary(null)).toBeNull();
    });
});

describe('the unrecognised-payload path', () => {
    it('reports WHY there is no gauge, rather than showing none silently', () => {
        // Prism refuses the whole payload when a field is unrecognised and routes the frame
        // to `particle.academy/unmapped_frame`. Their warning, which I would have walked
        // into: reading only `rate_limit` gives "no gauge and no explanation".
        const s = rateLimitSummary(null, { unrecognised: 'rate_limit payload not recognised' });
        expect(s).not.toBeNull();
        expect(s!.unavailable).toBe('rate_limit payload not recognised');
        expect(s!.binding).toBeNull();
    });

    it('prefers a real reading over a stale explanation', () => {
        // If both arrive, the parsed value wins: an explanation is only useful while there is
        // nothing to show.
        const s = rateLimitSummary(limit(), { unrecognised: 'stale' })!;
        expect(s.unavailable).toBeNull();
        expect(s.binding!.name).toBe('five_hour');
    });
});
