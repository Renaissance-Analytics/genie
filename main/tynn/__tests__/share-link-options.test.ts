import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SHARE_LINK_EXPIRY_DAYS,
    SHARE_LINK_EXPIRY_CHOICES,
    normalizeExpiryDays,
} from '../share-link-options';

/**
 * HOW LONG A SHARE LINK LIVES — the owner's first minting control.
 *
 * The number crosses an IPC boundary before it reaches Tynn, so main cannot take
 * the renderer's word for it: Tynn validates `expires_in_days` as an integer
 * 1..30 and REFUSES anything else with a 422, which would surface as "could not
 * create link" with no clue why. Normalising here means a bad value can only ever
 * cost the caller the default, never the link.
 *
 * Falling back rather than CLAMPING is deliberate. Clamping 45 to 30 hands back a
 * link that expires on a date nobody chose and says nothing about it; the default
 * is at least the documented behaviour of sending no value at all.
 */
describe('normalizeExpiryDays', () => {
    it('accepts every choice the UI offers', () => {
        // The guard must not refuse the values the picker is built from — a list
        // and a validator that disagree is a control that fails on a valid click.
        for (const days of SHARE_LINK_EXPIRY_CHOICES) {
            expect(normalizeExpiryDays(days)).toBe(days);
        }
    });

    it('accepts any whole number Tynn accepts, not just the offered ones', () => {
        // The choices are a convenience, not the contract. 1..30 is the contract.
        expect(normalizeExpiryDays(1)).toBe(1);
        expect(normalizeExpiryDays(3)).toBe(3);
        expect(normalizeExpiryDays(30)).toBe(30);
    });

    it('falls back to the default for anything Tynn would refuse', () => {
        // Each of these is a 422 from the service if it were forwarded.
        expect(normalizeExpiryDays(0)).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays(31)).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays(-7)).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays(7.5)).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays(Number.NaN)).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays(Number.POSITIVE_INFINITY)).toBe(
            DEFAULT_SHARE_LINK_EXPIRY_DAYS,
        );
    });

    it('falls back for anything that is not a number at all', () => {
        // `undefined` is the ordinary case — a caller that never asked — and the
        // rest are what an IPC message can carry when something upstream is wrong.
        expect(normalizeExpiryDays(undefined)).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays(null)).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays('7')).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
        expect(normalizeExpiryDays({ days: 7 })).toBe(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
    });

    it('offers a default that is one of the choices', () => {
        // Otherwise the picker opens on a value it cannot show as selected.
        expect(SHARE_LINK_EXPIRY_CHOICES).toContain(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
    });

    it('offers only choices Tynn accepts', () => {
        // The list is what the user can pick; every entry has to be mintable.
        for (const days of SHARE_LINK_EXPIRY_CHOICES) {
            expect(Number.isInteger(days)).toBe(true);
            expect(days).toBeGreaterThanOrEqual(1);
            expect(days).toBeLessThanOrEqual(30);
        }
    });
});
