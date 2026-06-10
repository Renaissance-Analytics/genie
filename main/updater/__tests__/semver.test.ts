import { describe, expect, it } from 'vitest';

// Mock electron before importing git-updater (which transitively imports
// `app` and `net` at module load). Vitest aliases electron globally in
// our config, so this just gives us a richer shim for the pieces git-updater
// actually touches at import time.
import '../../../test/electron-mock';

import { isNewer } from '../git-updater';

describe('isNewer', () => {
    it('compares plain x.y.z', () => {
        expect(isNewer('0.7.1', '0.7.0')).toBe(true);
        expect(isNewer('0.7.0', '0.7.1')).toBe(false);
        expect(isNewer('0.7.0', '0.7.0')).toBe(false);
        expect(isNewer('1.0.0', '0.99.99')).toBe(true);
        expect(isNewer('0.7.0', '0.6.99')).toBe(true);
    });

    it('treats unparseable input as a mismatch (conservatively "newer")', () => {
        // The updater's caller strips the leading v before calling. If a
        // stray "v" slips through, we don't crash — we fall back to a
        // string mismatch, which surfaces as "an update exists". Better
        // to nudge the user to refresh than to silently treat unknown as
        // up-to-date.
        expect(isNewer('0.7.1', 'v0.7.0')).toBe(true);
        expect(isNewer('garbage', 'garbage')).toBe(false);
    });

    it('orders releases above pre-releases at same x.y.z', () => {
        expect(isNewer('0.7.0', '0.7.0-alpha.1')).toBe(true);
        expect(isNewer('0.7.0-alpha.1', '0.7.0')).toBe(false);
    });

    it('compares pre-release identifiers lexicographically', () => {
        expect(isNewer('0.7.0-beta.1', '0.7.0-alpha.5')).toBe(true);
        expect(isNewer('0.7.0-alpha.10', '0.7.0-alpha.2')).toBe(true);
        expect(isNewer('0.7.0-alpha.1', '0.7.0-alpha.1')).toBe(false);
    });

    it('returns false for garbage input rather than throwing', () => {
        expect(() => isNewer('not-a-version', '0.0.0')).not.toThrow();
    });

    it('handles mixed numeric / alphanumeric pre-release identifiers', () => {
        // Per semver §11: numeric identifiers compare numerically;
        // alphanumeric compare lexically; numeric sort below alphanumeric.
        expect(isNewer('1.0.0-2', '1.0.0-1')).toBe(true);
        expect(isNewer('1.0.0-rc.1', '1.0.0-2')).toBe(true); // numeric < alphanumeric
        expect(isNewer('1.0.0-rc.10', '1.0.0-rc.9')).toBe(true); // dotted-numeric branch
    });
});
