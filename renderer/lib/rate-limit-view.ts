import type { RateLimitSummary } from '../../main/agentsession/rate-limit-headroom';

/**
 * Subscription headroom, as a surface renders it.
 *
 * Owner requirement, verbatim: *"I will measure this myself based on the amount of work I can do
 * before hitting rate limits on subscriptions. I do need to see what is remaining on rate limits
 * at least."*
 *
 * `main/agentsession/rate-limit.ts` already computes the headroom and is tested. Nothing
 * RENDERED it — `rateLimit` reached the session model, the renderer's types and an e2e fixture,
 * and no surface in the product read it. The measurement the owner intends to judge this whole
 * migration by was invisible, and the suite was green.
 *
 * Pure, because the renderer's test environment has no DOM: a decision made inside a component
 * is a decision nobody checks. Imported from `main/` deliberately — the same arrangement
 * `restart-options.ts` uses, so the host and the UI cannot disagree about a number.
 *
 * ## What this must never do
 *
 * Invent a reading. A pty agent will never report one, and `null` means CANNOT SEE — so the
 * surface renders nothing rather than full headroom. "100% left" for an agent nobody is metering
 * is the most expensive thing here could get wrong: it is the number a day's work gets planned
 * around.
 */

/** Below this, the gauge warns — while there is still something left to spend. */
const WARN_AT = 0.15;

/** How the provider's window keys read to a person. */
const WINDOW_LABELS: Record<string, string> = {
    five_hour: '5h',
    seven_day: '7d',
};

/**
 * A window's label.
 *
 * An unknown key is made readable rather than dropped or thrown on: the provider can add a
 * window, and a blank label would hide a limit that is real.
 */
export function windowLabel(name: string): string {
    if (WINDOW_LABELS[name]) return WINDOW_LABELS[name]!;
    const readable = name.replace(/_/g, ' ').trim();
    return readable || 'limit';
}

export type HeadroomTone = 'ok' | 'warn' | 'empty' | 'over' | 'blocked' | 'unknown';

export interface HeadroomWindowRow {
    label: string;
    /** Whole percent LEFT, clamped — the bar cannot render a negative. */
    percentLeft: number;
    resetsLabel: string;
    overspent: boolean;
}

export interface HeadroomDisplay {
    /** The sentence, leading with what is LEFT. */
    headline: string;
    tone: HeadroomTone;
    /** The binding window's label, or null when there is no reading. */
    bindingLabel: string | null;
    /** Whole percent for the bar, or null when there is nothing to draw. */
    barPercent: number | null;
    resetsLabel: string | null;
    windows: HeadroomWindowRow[];
    /** The provider's own sentence, or why there is no reading. DISPLAY ONLY. */
    note: string | null;
}

/**
 * When the window clears, relative to now.
 *
 * Relative because it answers the question actually being asked — "how long until I can work
 * again" — and because an absolute clock needs a timezone this layer has no business choosing.
 * A reset that has already passed reads as imminent rather than negative: the time passes
 * between frames, and "resets in -3m" is the kind of detail that makes a reader distrust every
 * other number on the screen.
 */
function resetsLabel(resetsAtMs: number, now: number): string {
    const ms = resetsAtMs - now;
    if (ms <= 60_000) return 'resets any moment';
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `resets in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${rest}m`;
}

/** Whole percent left, clamped. `remaining` is already clamped upstream; this rounds it. */
function percentLeft(remaining: number): number {
    return Math.round(Math.max(0, Math.min(1, remaining)) * 100);
}

export function headroomDisplay(
    summary: RateLimitSummary | null | undefined,
    now: number,
): HeadroomDisplay | null {
    if (!summary) return null;

    const windows = summary.windows.map((w) => ({
        label: windowLabel(w.name),
        percentLeft: percentLeft(w.remaining),
        resetsLabel: resetsLabel(w.resetsAtMs, now),
        overspent: w.overspent,
    }));

    const binding = summary.binding;
    if (!binding) {
        // No reading, but we know why — strictly better than an empty space. `rateLimitSummary`
        // only returns this shape when there IS an explanation, so there is always something to
        // say here.
        return {
            headline: 'no reading',
            tone: 'unknown',
            bindingLabel: null,
            barPercent: null,
            resetsLabel: null,
            windows,
            note: summary.unavailable ?? summary.notice ?? null,
        };
    }

    const left = percentLeft(binding.remaining);
    const resets = resetsLabel(binding.resetsAtMs, now);

    // ORDER MATTERS, most decisive first. A refusal outranks a percentage: `allowed: false` is
    // the provider saying no right NOW, and a cheerful figure beside it reads as a bug in Genie
    // rather than a limit on the account. Overspent outranks empty because only one of the two
    // is costing money.
    const tone: HeadroomTone = !summary.allowed
        ? 'blocked'
        : binding.overspent
          ? 'over'
          : binding.remaining <= 0
            ? 'empty'
            : binding.remaining <= WARN_AT
              ? 'warn'
              : 'ok';

    const headline =
        tone === 'blocked'
            ? 'rate limited'
            : tone === 'over'
              ? `${Math.round(binding.utilization * 100)}% used — into overage`
              : `${left}% left`;

    return {
        headline,
        tone,
        bindingLabel: binding.name ? windowLabel(binding.name) : null,
        barPercent: left,
        // Carried even when blocked: "limited, and it clears in 1h" is the useful sentence.
        resetsLabel: resets,
        windows,
        note: summary.notice ?? null,
    };
}
