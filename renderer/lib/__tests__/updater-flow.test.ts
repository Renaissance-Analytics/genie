import { describe, expect, it } from 'vitest';
import { shouldDriveRestart } from '../updater-flow';

/**
 * Regression guard for the UpdatePill double-restart bug. On a FRESH phase-2
 * apply (Upgrade → apply() → download → ready-to-restart), the electron-updater
 * backend already runs quitAndInstall itself via `installWhenReady`. The pill's
 * driver effect must NOT also call updater.restart(), or quitAndInstall fires
 * TWICE. shouldDriveRestart() is that gate — false on exactly the path where the
 * backend self-restarts.
 */
describe('shouldDriveRestart', () => {
    it('does NOT drive the restart on a FRESH phase-2 apply — the backend auto-restarts via installWhenReady, so quitAndInstall fires exactly once', () => {
        expect(
            shouldDriveRestart({ mode: 'phase2', appliedThisCommit: true }),
        ).toBe(false);
    });

    it('DOES drive the restart for a PRE-STAGED phase-2 build (apply never ran this session → installWhenReady unset → backend will not auto-restart)', () => {
        expect(
            shouldDriveRestart({ mode: 'phase2', appliedThisCommit: false }),
        ).toBe(true);
    });

    it('DOES drive the restart for phase-1 git — applyUpdate never auto-restarts; the frontend restart()+quit fallback applies', () => {
        expect(
            shouldDriveRestart({ mode: 'phase1', appliedThisCommit: true }),
        ).toBe(true);
        expect(
            shouldDriveRestart({ mode: 'phase1', appliedThisCommit: false }),
        ).toBe(true);
    });
});
