import { describe, expect, it } from 'vitest';
import { shouldShowMasterWindowOnBoot } from '../reopen-after-update';

/**
 * The boot decision that regressed: after an auto-update relaunch Genie stayed
 * in the tray instead of reopening its window. The window-show gate (added with
 * the "start minimized" setting) suppresses the open on an autostart launch, and
 * on Windows the updater's relaunch looks like one — so the user's actively-used
 * window silently vanished on every upgrade.
 *
 * The fix records the update-apply intent explicitly and lets it override the
 * autostart suppression, while still honouring the user's deliberate
 * `start_minimized` choice.
 */
describe('shouldShowMasterWindowOnBoot', () => {
    const base = {
        isE2E: false,
        fromAutostart: false,
        startMinimized: false,
        reopenAfterUpdate: false,
    };

    it('opens by default (a plain launch, default settings)', () => {
        expect(shouldShowMasterWindowOnBoot(base)).toBe(true);
    });

    it('stays in the tray on an autostart (OS sign-in) launch', () => {
        expect(shouldShowMasterWindowOnBoot({ ...base, fromAutostart: true })).toBe(false);
    });

    it('REOPENS after an update even when the relaunch looks like autostart — the regression', () => {
        expect(
            shouldShowMasterWindowOnBoot({ ...base, fromAutostart: true, reopenAfterUpdate: true }),
        ).toBe(true);
    });

    it('still honours an explicit start_minimized preference, even after an update', () => {
        // A deliberate "tray only" choice is not overridden by an update.
        expect(
            shouldShowMasterWindowOnBoot({ ...base, startMinimized: true, reopenAfterUpdate: true }),
        ).toBe(false);
    });

    it('never opens under E2E — the harness owns its window', () => {
        expect(shouldShowMasterWindowOnBoot({ ...base, isE2E: true })).toBe(false);
        expect(
            shouldShowMasterWindowOnBoot({ ...base, isE2E: true, reopenAfterUpdate: true }),
        ).toBe(false);
    });
});
