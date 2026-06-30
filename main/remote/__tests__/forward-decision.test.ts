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
});
