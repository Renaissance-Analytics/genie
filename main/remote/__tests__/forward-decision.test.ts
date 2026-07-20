import { describe, it, expect } from 'vitest';
import { shouldForwardToDriver } from '../forward-decision';

/** The pure routing decision for forwarding host alerts/prompts to a driver. */
describe('shouldForwardToDriver', () => {
    it('forwards when a CONTROL driver is connected', () => {
        expect(shouldForwardToDriver({ connected: true, capability: 'control' })).toBe(true);
    });

    it('does NOT forward to a readonly driver (it cannot act on a control prompt)', () => {
        expect(shouldForwardToDriver({ connected: true, capability: 'readonly' })).toBe(false);
    });

    it('does NOT forward when no driver is connected (host stays local)', () => {
        expect(shouldForwardToDriver({ connected: false, capability: 'control' })).toBe(false);
        expect(shouldForwardToDriver(null)).toBe(false);
        expect(shouldForwardToDriver(undefined)).toBe(false);
    });

    it('does NOT forward while the host kill-switch is engaged', () => {
        // The root cause of vanishing remote ForceTheQuestion answers: the host
        // handed out prompts over the UNGUARDED questions read, then refused the
        // GUARDED answer POST with 423 — so the driver answered into a void and
        // the host's agent stayed blocked. A locked host must forward nothing.
        expect(
            shouldForwardToDriver({ connected: true, capability: 'control', controlLocked: true }),
        ).toBe(false);
    });

    it('forwards again once the lock is released', () => {
        expect(
            shouldForwardToDriver({ connected: true, capability: 'control', controlLocked: false }),
        ).toBe(true);
    });

    it('treats an absent lock flag as unlocked (callers that have no notion of it)', () => {
        expect(shouldForwardToDriver({ connected: true, capability: 'control' })).toBe(true);
    });
});
