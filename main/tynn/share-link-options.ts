/**
 * The minting controls for a share link — starting with how long it lives.
 *
 * A link is a credential that anyone can forward, so the only real limits on it
 * are its expiry and the owner's ability to revoke it. Tynn already validated
 * `expires_in_days` as an integer 1..30 and defaulted it to 7; Genie simply never
 * sent one, so every link the owner minted expired in a week whether that was
 * what they wanted or not.
 *
 * Pure and dependency-free so it can be shared by main (which must not trust the
 * renderer's number) and the renderer (which builds the picker from the same
 * list). One list means the control and the guard cannot disagree.
 */

/** Tynn's own bounds for `expires_in_days`, restated so the guard is readable. */
const MIN_DAYS = 1;
const MAX_DAYS = 30;

/** What the picker offers. A convenience, not the contract — {@link
 *  normalizeExpiryDays} accepts anything in range, so a future control that types
 *  a number needs no change here. */
export const SHARE_LINK_EXPIRY_CHOICES = [1, 7, 14, 30] as const;

/** Tynn's own default, restated so Genie sends what it means rather than relying
 *  on the service's omission behaviour. */
export const DEFAULT_SHARE_LINK_EXPIRY_DAYS = 7;

/**
 * The expiry to actually send, for whatever arrived.
 *
 * FALLS BACK rather than clamping. Clamping 45 to 30 mints a link that expires on
 * a date nobody chose and says nothing about it; the default is at least the
 * behaviour the service documents for sending no value at all. Either way the
 * user keeps their link — a value this could not read must never be the reason a
 * mint fails, because the 422 it would cause arrives as "could not create link"
 * with nothing to act on.
 */
export function normalizeExpiryDays(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return DEFAULT_SHARE_LINK_EXPIRY_DAYS;
    if (raw < MIN_DAYS || raw > MAX_DAYS) return DEFAULT_SHARE_LINK_EXPIRY_DAYS;
    return raw;
}
