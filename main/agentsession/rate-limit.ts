/**
 * Subscription headroom — "how much work can I do before I hit the wall".
 *
 * Owner requirement: *"I will measure this myself based on the amount of work I can do before
 * hitting rate limits on subscriptions. I do need to see what is remaining on rate limits at
 * least."*
 *
 * ## It is a gauge, and that was measured
 *
 * Prism holds three independently captured turns, each carrying one `rate_limit_event`. In all
 * three `status` is `"allowed"`, the frame arrives about a quarter of the way into the stream,
 * and `five_hour.utilization` reads 0.10, 0.12, 0.13 — it moves with work done. So this is a
 * live meter, not a breach notification, and a gauge is the honest surface. Had it only fired
 * on breach, the honest surface would have been "limited until X" and we would both have
 * stopped calling it a remaining-budget feature.
 *
 * ## Two facts that would have shipped wrong
 *
 * **The provider sends epoch SECONDS.** `1791260400` read as milliseconds is January 1970.
 * `prism-acp` converts once and names the field for its unit (`resetsAtMs`), so nothing here
 * multiplies by 1000 on a hunch — a wrong-but-plausible date passes a glance, which is exactly
 * how it would have shipped.
 *
 * **`utilization` can exceed 1.** The provider models overage (`isUsingOverage`,
 * `overageStatus`), so a window consumed past its allowance is a real state and
 * `1 - utilization` goes negative. Clamping is for the BAR, never for the number.
 *
 * ## Shapes, not a parse
 *
 * The narrowing parse is `readRateLimit` in `prism-acp` — ours, at the boundary, where an
 * unrecognised payload refuses TOTALLY rather than returning a partial, and says which field
 * failed. This module only consumes the result, and imports the types rather than restating
 * them: a second declaration of the same shape is how two packages drift apart.
 */
import type { ClaudeRateLimit, ClaudeRateLimitWindow } from '@particle-academy/prism-acp';

/**
 * The provider's reading, plus the sentence that rode with it.
 *
 * The types come from `prism-acp` rather than being mirrored here — it owns the parse, and a
 * second declaration of the same shape is how the two drift. `notice` is ours: it is on the
 * `notice` update the `_meta` rides on, not on the typed payload, and it is DISPLAY ONLY.
 * Prism changed that text once already and says it is deliberately unstable, so nothing keys
 * on it.
 */
export type SessionRateLimit = ClaudeRateLimit & { notice: string | null };

export interface WindowHeadroom {
    name: string;
    /** Fraction left, CLAMPED to 0 for display. Never negative. */
    remaining: number;
    /** The real figure, unclamped, so "full" and "exceeded" stay distinguishable. */
    utilization: number;
    /** True when the window is consumed PAST its allowance, not merely full. */
    overspent: boolean;
    resetsAtMs: number;
}

export interface RateLimitSummary {
    /** False for any status that is not exactly `allowed`. */
    allowed: boolean;
    /** The window that will stop you first, or null when none were reported. */
    binding: WindowHeadroom | null;
    /** Every window — they disagree, and both matter. */
    windows: WindowHeadroom[];
    usingOverage: boolean;
    overageStatus: string | null;
    notice: string | null;
    /**
     * Why there is no reading, when there is none.
     *
     * Prism refuses the whole payload if a field is unrecognised and routes the frame to
     * `particle.academy/unmapped_frame`. Their warning, which this exists to answer: reading
     * only `rate_limit` leaves "no gauge and no explanation". This carries the explanation.
     */
    unavailable: string | null;
}

/** Headroom for one window: clamped for the bar, honest in the number. */
export function windowHeadroom(w: ClaudeRateLimitWindow, name = ''): WindowHeadroom {
    return {
        name,
        // Clamp for DISPLAY. A bar cannot render -0.4, and rounding silently would lose the
        // fact that the window is exceeded rather than merely empty.
        remaining: Math.max(0, 1 - w.utilization),
        utilization: w.utilization,
        overspent: w.utilization > 1,
        resetsAtMs: w.resetsAtMs,
    };
}

/**
 * The window that stops you first.
 *
 * `rateLimitType` is the provider's own answer, so it wins: choosing the lowest-headroom
 * window ourselves would be a guess that can disagree with the thing actually enforcing the
 * limit. When it names a window we were not sent, the TIGHTEST window is the fallback —
 * reporting nothing would hide a real limit and taking the first key would be arbitrary.
 */
export function bindingWindow(limit: SessionRateLimit): WindowHeadroom | null {
    const entries = Object.entries(limit.windows);
    if (entries.length === 0) return null;

    const named = limit.windows[limit.rateLimitType];
    if (named) return windowHeadroom(named, limit.rateLimitType);

    let worst: WindowHeadroom | null = null;
    for (const [name, w] of entries) {
        const h = windowHeadroom(w, name);
        if (!worst || h.utilization > worst.utilization) worst = h;
    }
    return worst;
}

/**
 * What a surface renders.
 *
 * Returns null only when there is genuinely nothing to say — no reading and no explanation,
 * which is the normal state of a pty agent that will never report one. A surface must then
 * render NOTHING rather than full headroom.
 */
export function rateLimitSummary(
    limit: SessionRateLimit | null | undefined,
    fallback?: { unrecognised?: string | null },
): RateLimitSummary | null {
    if (!limit) {
        const why = fallback?.unrecognised ?? null;
        if (!why) return null;
        // No reading, but we know why — which is strictly better than an empty space.
        return {
            allowed: true,
            binding: null,
            windows: [],
            usingOverage: false,
            overageStatus: null,
            notice: null,
            unavailable: why,
        };
    }

    return {
        // Never a match on a breach spelling — see the note on `status`.
        allowed: limit.status === 'allowed',
        binding: bindingWindow(limit),
        windows: Object.entries(limit.windows).map(([name, w]) => windowHeadroom(w, name)),
        usingOverage: limit.isUsingOverage === true,
        overageStatus: limit.overageStatus ?? null,
        notice: limit.notice,
        // A real reading beats a stale explanation: the explanation is only useful while
        // there is nothing to show.
        unavailable: null,
    };
}
