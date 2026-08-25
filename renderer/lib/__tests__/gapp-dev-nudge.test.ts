import { describe, expect, it } from 'vitest';
import { NUDGE_MIN_GAP_MS, shouldNudgeGappDevSync } from '../gapp-dev';

/**
 * The nudge costs a `whoami` + a project fetch, and it hangs off window focus —
 * which fires on every alt-tab, in EVERY window, and Stage windows load the same
 * master page. Left ungated, drumming alt-tab would drum Tynn.
 *
 * The gap is short on purpose. Its whole job is to collapse a burst of focus
 * events into one; anything long enough to swallow a real "I flipped the flag in
 * Tynn and came straight back" round trip would re-create the bug this feature
 * exists to fix.
 */
describe('shouldNudgeGappDevSync', () => {
    it('always nudges the first time — there is nothing to collapse yet', () => {
        expect(shouldNudgeGappDevSync(1_000, null)).toBe(true);
    });

    it('collapses a burst of focus events into one', () => {
        expect(shouldNudgeGappDevSync(1_000, 1_000)).toBe(false);
        expect(shouldNudgeGappDevSync(1_000 + NUDGE_MIN_GAP_MS - 1, 1_000)).toBe(false);
    });

    it('lets the next one through once the gap has passed', () => {
        expect(shouldNudgeGappDevSync(1_000 + NUDGE_MIN_GAP_MS, 1_000)).toBe(true);
        expect(shouldNudgeGappDevSync(60_000, 1_000)).toBe(true);
    });

    it('stays short enough that a trip to Tynn and back is never swallowed', () => {
        // Flipping the flag means opening Tynn, finding the project, toggling it
        // and switching back. If this number ever grew past a few seconds, the
        // user's own round trip would land inside the gap and Genie would look
        // exactly as unresponsive as it did before this feature.
        expect(NUDGE_MIN_GAP_MS).toBeLessThanOrEqual(5_000);
        expect(NUDGE_MIN_GAP_MS).toBeGreaterThan(0);
    });

    it('nudges when the clock goes BACKWARDS rather than locking up until it catches up', () => {
        // A system clock correction must not strand the sync. Failing OPEN costs
        // one request; failing closed costs the feature.
        expect(shouldNudgeGappDevSync(500, 10_000)).toBe(true);
    });
});
