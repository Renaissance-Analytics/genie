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
 * ## Where the arithmetic lives
 *
 * In `./rate-limit-headroom.ts`, over a structural parameter, because the renderer imports it
 * and `renderer/lib/__tests__/renderer-main-boundary.test.ts` refuses a `main/` module that
 * reaches a bare package specifier — this file imports prism's types, and prism is ESM-only.
 * That guard is not a style rule: an ESM-only package required from the CJS main bundle killed
 * the main process at boot once already.
 *
 * This file is still where the prism types enter, and the re-exports below keep every host
 * caller's import unchanged.
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

/**
 * The arithmetic, re-exported so host callers import it from the module that owns the SHAPE.
 *
 * `SessionRateLimit` and `ClaudeRateLimitWindow` are assignable to `HeadroomInput` and
 * `HeadroomWindowInput`, and that assignment is checked wherever a caller passes one in — which
 * is the drift guard. A field prism renames stops a build instead of quietly reading
 * `undefined`.
 */
export {
    bindingWindow,
    rateLimitSummary,
    windowHeadroom,
    type RateLimitSummary,
    type WindowHeadroom,
} from './rate-limit-headroom';
