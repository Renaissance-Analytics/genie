import { describe, expect, it, beforeEach, vi } from 'vitest';

import '../../../test/electron-mock';

/**
 * THE LAST MOMENT ANYTHING IS STILL RUNNING (genie#551).
 *
 * `restartAndApply` is the one funnel every upgrade reaches — the header pill,
 * the staged-build banner, the drained apply, the phone's `installUpdate`, and
 * the hands-free finish inside the `update-downloaded` handler that no caller
 * can wrap. Genie hands over to the installer here, and everything the upgrade
 * is about to end is still up on the line above.
 *
 * That makes it the only correct place to write down WHAT is up. The roster
 * used to be written by `beginUpgradeDrain` instead, which is a different
 * question — and a forced apply, which is allowed to skip the drain and is the
 * whole point of the Force Restart escape, therefore quit with no restore list
 * at all.
 *
 * This drives the REAL `restartAndApply` with the real `update-downloaded`
 * handler in front of it, and asserts the ORDER: the hook runs, and the quit
 * follows it. A hook that ran after `quitAndInstall` would be a hook that never
 * ran.
 */

const stub = vi.hoisted(() => {
    const handlers = new Map<string, (payload: unknown) => void>();
    return {
        handlers,
        autoUpdater: {
            autoDownload: true,
            autoInstallOnAppQuit: true,
            logger: null as unknown,
            on(event: string, fn: (payload: unknown) => void) {
                handlers.set(event, fn);
            },
            checkForUpdates: vi.fn(),
            downloadUpdate: vi.fn(),
            quitAndInstall: vi.fn(),
        },
    };
});

vi.mock('electron-updater', () => ({ autoUpdater: stub.autoUpdater }));
vi.mock('../git-updater', () => ({ isNewer: () => true }));
vi.mock('../quit-state', () => ({ markQuittingForUpdate: () => {} }));
vi.mock('../update-surface', () => ({
    appImageUpdateUnavailable: () => false,
    planManualDownload: () => ({ available: false }),
}));
vi.mock('../../db', () => ({ setSettings: () => {} }));

import { autoUpdaterInstance } from '../auto-updater';

/**
 * Drive a real Upgrade click as far as a staged build, WITHOUT applying it.
 *
 * `setRestartRequest` is what stops the hands-free finish from quitting on its
 * own (genie#565) — so the updater settles on 'ready-to-restart' and the test
 * gets to call the apply itself, which is the thing under test.
 */
async function stagedBuild() {
    const a = autoUpdaterInstance();
    a.setRestartRequest(vi.fn());
    stub.autoUpdater.checkForUpdates.mockResolvedValue({
        updateInfo: { version: '9.9.9', releaseDate: null },
    });
    stub.autoUpdater.downloadUpdate.mockResolvedValue(undefined);

    await a.checkForUpdate();
    await a.downloadAndInstall();
    const fire = stub.handlers.get('update-downloaded');
    expect(fire, 'update-downloaded was never registered').toBeTypeOf('function');
    fire!({ version: '9.9.9' });
    // Everything below is about the apply; if we are not staged, it is about
    // nothing.
    expect(a.getStatus().state).toBe('ready-to-restart');
    return a;
}

beforeEach(() => {
    stub.autoUpdater.quitAndInstall.mockReset();
    stub.autoUpdater.checkForUpdates.mockClear();
    stub.autoUpdater.downloadUpdate.mockClear();
});

describe('restartAndApply — the pre-apply seam', () => {
    // FIRST, deliberately: `autoUpdaterInstance()` is a process-wide singleton
    // and `stagedBuild` leaves it staged for the rest of the file. This is the
    // only point at which "nothing has been downloaded" is still true.
    it('does not reach the hook when there is nothing staged to apply', () => {
        // Recording a roster for an upgrade that is not happening would leave a
        // list the next ordinary launch replays — restarting a set from an
        // upgrade that never ran.
        const a = autoUpdaterInstance();
        const hook = vi.fn();
        a.setBeforeApply(hook);

        expect(() => a.restartAndApply()).toThrow(/No update/);
        expect(hook).not.toHaveBeenCalled();
    });

    it('runs the hook BEFORE handing over to the installer', async () => {
        const a = await stagedBuild();
        const order: string[] = [];
        stub.autoUpdater.quitAndInstall.mockImplementation(() => {
            order.push('quit');
        });
        a.setBeforeApply(() => {
            order.push('record');
        });

        a.restartAndApply();

        expect(order).toEqual(['record', 'quit']);
    });

    it('applies anyway when the hook throws', async () => {
        // A restore list is worth a lot. It is not worth an upgrade that will
        // not install: the boot on the other side then finds no roster, which
        // is exactly today's behaviour, and the failure is logged.
        const a = await stagedBuild();
        a.setBeforeApply(() => {
            throw new Error('the database is locked');
        });

        expect(() => a.restartAndApply()).not.toThrow();
        expect(stub.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it('applies with no hook wired at all', async () => {
        // POSITIVE CONTROL. Both assertions above would pass against an apply
        // that had quietly stopped applying; this one would not.
        const a = await stagedBuild();
        a.setBeforeApply(undefined as never);

        a.restartAndApply();

        expect(stub.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
});
