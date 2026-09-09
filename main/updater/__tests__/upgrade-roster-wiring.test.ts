import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../test/electron-mock';

/**
 * THE WIRING (genie#551) — which roster the apply seam writes, and when it
 * leaves the one that is already there alone.
 *
 * The decision is one boolean, and the whole bug is in choosing WHICH boolean.
 * `upgrade-roster.test.ts` pins the decision; this pins the input it is asked
 * for, because a guard reading the wrong true-looking fact is exactly how the
 * first attempt at this fix reintroduced the bug it was written to remove.
 */

/** The drain-service's state, under the test's control. Hoisted with the mock
 *  factory, which vitest lifts above every import. */
const svc = vi.hoisted(() => ({
    rosterExists: false,
    drainHasCleared: false,
    recorded: vi.fn(),
}));

vi.mock('../../agents/drain-service', () => ({
    beginUpgradeDrain: () => Promise.resolve({ complete: true }),
    cancelUpgradeDrain: () => {},
    drainSnapshot: () => ({ active: false, startedAt: 0, rows: [], complete: true }),
    liveDrainableAgentCount: () => 0,
    markUpgradeDrainCleared: () => {},
    markUpgradeRestartForced: () => {},
    pendingDrainRestore: () => svc.rosterExists,
    recordUpgradeRoster: svc.recorded,
    satisfyDrainRow: () => ({ active: false, startedAt: 0, rows: [], complete: true }),
    upgradeDrainCleared: () => svc.drainHasCleared,
}));

// registerUpdaterIpc transitively imports these; inert so the module graph
// loads. Only the pre-apply hook is exercised here.
vi.mock('../../terminal/host-service', () => ({
    hostBackendKind: () => 'inprocess',
    detachedHostPinsBinary: () => false,
}));
vi.mock('../../terminal/quit-confirm', () => ({ liveHostTerminals: () => [] }));
vi.mock('../git-updater', () => ({ updater: () => ({}) }));
vi.mock('../auto-updater', () => ({
    autoUpdaterInstance: () => ({}),
    updaterMode: () => 'phase2',
}));
vi.mock('../../db', () => ({
    getAllSettings: () => ({}),
    setSettings: () => {},
    getTerminalSpec: () => null,
}));
vi.mock('../../tray', () => ({ setUpdateAvailable: () => {} }));
vi.mock('../../background', () => ({ showSettingsWindow: () => {}, showMasterWindow: () => {} }));
vi.mock('../changelog', () => ({ getChangelog: async () => ({}) }));

import { recordRosterBeforeApply } from '../ipc';

afterEach(() => {
    svc.recorded.mockReset();
    svc.rosterExists = false;
    svc.drainHasCleared = false;
});

describe('recordRosterBeforeApply', () => {
    it('records when a FORCED apply skipped the drain entirely', () => {
        // genie#551. `mobileInstallUpdate(force)` from 'ready-to-restart' calls
        // `requestUpgradeRestart({ force: true })`, whose force branch applies
        // on the spot — `beginUpgradeDrain` never runs, so nothing ever wrote a
        // list. Everything running goes, and the boot on the other side finds
        // no record that any of it existed.
        svc.rosterExists = false;
        svc.drainHasCleared = false;

        recordRosterBeforeApply();

        expect(svc.recorded).toHaveBeenCalledTimes(1);
    });

    it('leaves the DRAIN’s roster alone once it has cleared', () => {
        // The drain records before the first nudge; by the time it clears, the
        // agents on that list have handed off and exited. Re-recording here
        // walks a machine they are no longer on and writes an empty list over a
        // correct one.
        svc.rosterExists = true;
        svc.drainHasCleared = true;

        recordRosterBeforeApply();

        expect(svc.recorded).not.toHaveBeenCalled();
    });

    it('leaves it alone on a Force Restart taken MID-DRAIN, where nothing cleared', () => {
        // THE REGRESSION THIS TEST EXISTS FOR. Here `upgradeDrainCleared()` is
        // false — the drain was abandoned by a person, not completed — and a
        // complete roster is on disk all the same. The agents already showing
        // green are precisely the ones that have exited, so a re-record drops
        // exactly them.
        //
        // A guard reading `drainCleared` passes the two tests above and fails
        // this one. That is the whole reason this case is written down.
        svc.rosterExists = true;
        svc.drainHasCleared = false;

        recordRosterBeforeApply();

        expect(svc.recorded).not.toHaveBeenCalled();
    });

    it('does not let a recorder that throws stop the upgrade', () => {
        svc.rosterExists = false;
        svc.recorded.mockImplementationOnce(() => {
            throw new Error('the database is locked');
        });

        expect(() => recordRosterBeforeApply()).not.toThrow();
    });
});
