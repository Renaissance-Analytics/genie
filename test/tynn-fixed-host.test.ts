import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { TYNN_HOST } from '../src/core/tynn.js';

/**
 * TYNN IS NOT A CHANGEABLE HOST (the owner, 2026-10-21, of Settings → Tynn's "Change Tynn host": "tynn is not a
 * changeable host wtf is this? if you need this for the vm testing just set the host file in the test vm to point their
 * tynn.ai to the tynn.gen site hosted on this machine"). Genie always talks to tynn.ai; there is no setting for it.
 */
describe('the Tynn host', () => {
    it('is tynn.ai, fixed', () => {
        expect(TYNN_HOST).toBe('https://tynn.ai');
    });

    it('is not a setting (CONTROL: the Tynn-gated settings still exist)', () => {
        expect(SETTINGS.some((s) => s.key === 'tynn_host')).toBe(false);
        expect(SETTINGS.length).toBeGreaterThan(10);
    });
});
