/**
 * The headroom MATH, over the minimum shape it consumes — and nothing else.
 *
 * A LEAF, deliberately: `renderer/lib/__tests__/renderer-main-boundary.test.ts` refuses any
 * `main/` module the renderer imports that reaches a bare package specifier, and its message
 * says why — *"drags a runtime dependency into the renderer's compilation"*. `./rate-limit.ts`
 * imports its types from `@particle-academy/prism-acp`, which is ESM-only; an ESM-only package
 * required from the CJS main bundle killed the main process at boot once already, so that guard
 * is not a style rule.
 *
 * So the split is: prism's types stay next door, and the arithmetic lives here over a
 * structural parameter — the fields it actually reads. That is not a restatement of prism's
 * shape, it is the subset this computation needs, and `./rate-limit.ts` passes prism's own type
 * straight in. The compiler checks that assignment at the call site, so a renamed field there
 * stops the build rather than drifting quietly.
 */

/** The window fields the arithmetic reads. Prism's `ClaudeRateLimitWindow` satisfies it. */
export interface HeadroomWindowInput {
    /** Fraction of the allowance consumed. CAN exceed 1 — the provider models overage. */
    utilization: number;
    /** Epoch MILLISECONDS. Prism converts from the provider's seconds and names the unit. */
    resetsAtMs: number;
}

/** The reading the arithmetic reads. `SessionRateLimit` satisfies it. */
export interface HeadroomInput {
    status: string;
    rateLimitType: string;
    windows: Record<string, HeadroomWindowInput>;
    isUsingOverage?: boolean | undefined;
    overageStatus?: string | null | undefined;
    notice: string | null;
}

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
export function windowHeadroom(w: HeadroomWindowInput, name = ''): WindowHeadroom {
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
export function bindingWindow(limit: HeadroomInput): WindowHeadroom | null {
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
    limit: HeadroomInput | null | undefined,
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
        // Never a match on a breach spelling — see the note on `status` in `./rate-limit.ts`.
        allowed: limit.status === 'allowed',
        binding: bindingWindow(limit),
        windows: Object.entries(limit.windows).map(([name, w]) => windowHeadroom(w, name)),
        usingOverage: limit.isUsingOverage === true,
        overageStatus: limit.overageStatus ?? null,
        notice: limit.notice,
        // A real reading beats a stale explanation: the explanation is only useful while there
        // is nothing to show.
        unavailable: null,
    };
}
