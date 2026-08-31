import { describe, expect, it } from 'vitest';
import { autoOpenWhatsNew, shouldShowWhatsNew } from '../whats-new';

describe("What's new upgrade gate", () => {
    it('opens once for a newly observed version, including the feature’s first rollout', () => {
        expect(shouldShowWhatsNew(undefined, '0.7.0-beta.274')).toBe(true);
        expect(shouldShowWhatsNew('0.7.0-beta.273', '0.7.0-beta.274')).toBe(true);
        expect(shouldShowWhatsNew('0.7.0-beta.274', '0.7.0-beta.274')).toBe(false);
    });
});

/**
 * A full-screen modal must never arrive AFTER the window is interactive.
 *
 * `openWhatsNew(true)` runs on mount and awaits two IPC round-trips before
 * opening `.whats-new-backdrop` — `position: fixed; inset: 0; z-index: 5000`.
 * So the modal lands an arbitrary time after first paint, over whatever the user
 * is doing, and swallows the click they were making.
 *
 * E2E caught this and it was read as a sidebar regression for three releases:
 * the tests that only ASSERT (132-209) pass, and the first test that CLICKS
 * (238) times out with the element resolved but not actionable — because a
 * full-screen backdrop is over it. `switchToWorkspace` never lands.
 *
 * The announcement is not lost when it is skipped: the owner asked for it to be
 * reopenable from the header menu, so declining to steal a click costs nothing
 * but a menu click, while stealing one costs a misdirected action.
 */
describe('autoOpenWhatsNew', () => {
    const base = { previous: '0.7.0-beta.283', current: '0.7.0-beta.284', budgetMs: 1500 };

    it('opens when the decision resolves while the window is still settling', () => {
        expect(autoOpenWhatsNew({ ...base, elapsedMs: 200 })).toBe(true);
    });

    it('does NOT open once the window has been interactive too long', () => {
        // The whole point: past the budget the user may be mid-gesture, and a
        // modal that appears then takes the click instead of the thing they aimed at.
        expect(autoOpenWhatsNew({ ...base, elapsedMs: 9000 })).toBe(false);
    });

    it('still respects the seen-version rule inside the budget', () => {
        // Positive control on the existing behaviour: being fast must not turn
        // an already-seen version into a fresh announcement.
        expect(
            autoOpenWhatsNew({ ...base, previous: '0.7.0-beta.284', elapsedMs: 200 }),
        ).toBe(false);
    });

    it('opens for a first run, where there is no previous version', () => {
        expect(autoOpenWhatsNew({ ...base, previous: undefined, elapsedMs: 200 })).toBe(true);
    });
});
