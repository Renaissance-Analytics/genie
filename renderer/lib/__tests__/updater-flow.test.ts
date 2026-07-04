import { describe, expect, it } from 'vitest';
import { planCommitStep, shouldDriveRestart } from '../updater-flow';

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

/**
 * Regression guard for the WEDGED "Upgrading…" pill. A committed update whose
 * apply died (download errored, or the apply IPC was refused) used to leave the
 * one-shot refs armed and `committed` true forever: the next 'available' then
 * rendered a committed pill with NO button and NO driver — stuck on
 * "Upgrading…" until Genie itself was restarted. planCommitStep's 'reset' is
 * the disarm that hands the pill back.
 */
describe('planCommitStep', () => {
    const base = {
        committed: true,
        applied: false,
        restarted: false,
        manualDownloadUrl: null,
    };

    it('does nothing before the user commits', () => {
        expect(
            planCommitStep({ ...base, committed: false, state: 'available' }),
        ).toBe('none');
    });

    it('applies exactly once from available', () => {
        expect(planCommitStep({ ...base, state: 'available' })).toBe('apply');
        expect(
            planCommitStep({ ...base, state: 'available', applied: true }),
        ).toBe('none');
    });

    it('never auto-applies a manual-download update', () => {
        expect(
            planCommitStep({
                ...base,
                state: 'available',
                manualDownloadUrl: 'https://example.com/release',
            }),
        ).toBe('none');
    });

    it('restarts exactly once from ready-to-restart', () => {
        expect(planCommitStep({ ...base, state: 'ready-to-restart' })).toBe(
            'restart',
        );
        expect(
            planCommitStep({
                ...base,
                state: 'ready-to-restart',
                restarted: true,
            }),
        ).toBe('none');
    });

    it("RESETS a committed cycle when the update dies — 'error' must disarm, or the pill wedges on \"Upgrading…\"", () => {
        // The wedge: download failed → 'error' → (later re-check) → 'available'
        // with the refs still armed. 'error' must return 'reset' so that next
        // 'available' starts a fresh, clickable cycle.
        expect(planCommitStep({ ...base, state: 'error', applied: true })).toBe(
            'reset',
        );
    });

    it("RESETS when a re-check concludes we're already current", () => {
        expect(
            planCommitStep({ ...base, state: 'up-to-date', applied: true }),
        ).toBe('reset');
    });

    it('rides the working states without interfering', () => {
        expect(planCommitStep({ ...base, state: 'downloading', applied: true })).toBe('none');
        expect(planCommitStep({ ...base, state: 'checking', applied: true })).toBe('none');
        expect(planCommitStep({ ...base, state: 'applying', applied: true })).toBe('none');
    });
});
