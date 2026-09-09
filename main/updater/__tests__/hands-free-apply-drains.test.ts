import { describe, expect, it, beforeEach, vi } from 'vitest';

import '../../../test/electron-mock';

/**
 * THE HOP THE OWNER ACTUALLY HIT (genie#565).
 *
 * Reported as: *"when I click the upgrade button, it just shuts upgrades and
 * shuts down before the agents fire thumbs up."*
 *
 * One Upgrade click runs `apply()` → `downloadAndInstall()`, which arms
 * `installWhenReady` and downloads. When the build lands, `update-downloaded`
 * fires — and that handler called `this.restartAndApply()` → `quitAndInstall`
 * DIRECTLY. No drain, no roster, no thumb. `downloadAndInstall`'s own comment
 * said so out loud: *"One user click drives download → install → restart with
 * no further prompts."*
 *
 * Every other test in this change exercises the drain, the gate, or the pure
 * plans. None of them would have caught this, because the bug was never in a
 * decision — it was one call site that asked nobody. So this drives the REAL
 * `update-downloaded` handler, through the real `downloadAndInstall`, and
 * asserts which of the two things it reaches.
 *
 * The first test is the reproduction: with no gate wired, the handler still
 * quits hands-free. That is the shipped behaviour, and it is what makes the
 * second test — the same path, gated — mean anything.
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
// Every version is "newer" — the check only has to reach 'available'; which
// version wins is settled in semver.test.ts.
vi.mock('../git-updater', () => ({ isNewer: () => true }));
vi.mock('../quit-state', () => ({ markQuittingForUpdate: () => {} }));
vi.mock('../update-surface', () => ({
    appImageUpdateUnavailable: () => false,
    planManualDownload: () => ({ available: false }),
}));
vi.mock('../../db', () => ({ setSettings: () => {} }));

import { autoUpdaterInstance } from '../auto-updater';

/** Drive one Upgrade click as far as the downloaded build, then hand back the
 *  `update-downloaded` handler so the test can fire it. */
async function armedDownload() {
    const a = autoUpdaterInstance();
    stub.autoUpdater.checkForUpdates.mockResolvedValue({
        updateInfo: { version: '9.9.9', releaseDate: null },
    });
    stub.autoUpdater.downloadUpdate.mockResolvedValue(undefined);

    await a.checkForUpdate();
    expect(a.getStatus().state).toBe('available');

    // THE CLICK. `installWhenReady` is armed from here on.
    await a.downloadAndInstall();

    const fire = stub.handlers.get('update-downloaded');
    // The handler must exist, or every assertion below is about nothing.
    expect(fire, 'update-downloaded was never registered').toBeTypeOf('function');
    return { a, fire: fire! };
}

beforeEach(() => {
    stub.autoUpdater.quitAndInstall.mockClear();
    stub.autoUpdater.checkForUpdates.mockClear();
    stub.autoUpdater.downloadUpdate.mockClear();
});

describe('the hands-free apply that a single Upgrade click arms', () => {
    it('REPRODUCES the report: with no gate wired it quits, asking nobody', async () => {
        const { a, fire } = await armedDownload();
        // Deliberately no `setRestartRequest` — this is the shipped path, and
        // the interruption probe is unset, exactly as it behaves when the pty
        // host survives the swap and the probe reports nothing live.
        a.setRestartRequest(undefined as never);

        fire({ version: '9.9.9' });

        expect(stub.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it('goes through the GATE instead once one is wired', async () => {
        const { a, fire } = await armedDownload();
        const gate = vi.fn();
        a.setRestartRequest(gate);

        fire({ version: '9.9.9' });

        // The whole fix, in two lines: the gate is asked, and nothing quits
        // until it says so.
        expect(gate).toHaveBeenCalledTimes(1);
        expect(stub.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('still reaches ready-to-restart, so the roster has a version to name', async () => {
        const { a, fire } = await armedDownload();
        a.setRestartRequest(vi.fn());

        fire({ version: '9.9.9' });

        const status = a.getStatus();
        expect(status.state).toBe('ready-to-restart');
        expect(status.latestVersion).toBe('9.9.9');
    });

    it('disarms after one download, so a second event cannot re-fire it', async () => {
        const { a, fire } = await armedDownload();
        const gate = vi.fn();
        a.setRestartRequest(gate);

        fire({ version: '9.9.9' });
        fire({ version: '9.9.9' });

        // electron-updater can re-emit for a cached build. The gate is
        // idempotent anyway, but arming twice would mean two drains.
        expect(gate).toHaveBeenCalledTimes(1);
    });
});
