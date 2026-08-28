import { describe, expect, it } from 'vitest';
import { shouldShowWhatsNew } from '../whats-new';

describe("What's new upgrade gate", () => {
    it('opens once for a newly observed version, including the feature’s first rollout', () => {
        expect(shouldShowWhatsNew(undefined, '0.7.0-beta.274')).toBe(true);
        expect(shouldShowWhatsNew('0.7.0-beta.273', '0.7.0-beta.274')).toBe(true);
        expect(shouldShowWhatsNew('0.7.0-beta.274', '0.7.0-beta.274')).toBe(false);
    });
});
