import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN UPGRADE THAT APPLIES WITHOUT A DRAIN STILL RECORDS THE RESTORE LIST
 * (genie#551).
 *
 * genie#389 put the roster inside `beginUpgradeDrain`, so recording what was
 * running became a consequence of deciding to nudge. The decision to nudge is
 * `restartPlanForUpgrade`, fed from `describeRestartInterruption()` — a probe of
 * *what the installer swap tears down*, which returns ZERO whenever the pty host
 * is expected to survive it. On such a machine the plan is always `apply`, the
 * drain never begins, and no roster is ever written. Nothing to restore, and no
 * trace that anything should have been.
 *
 * `restartAndApply()` is the ONE funnel every apply reaches: the pill, the
 * hands-free finish inside `update-downloaded`, the drained apply, and the phone.
 * So the pre-apply hook lives here, where a new door cannot be added past it.
 *
 * These tests drive the REAL AutoUpdater with electron-updater mocked — the same
 * harness `update-flow.test.ts` uses.
 */

const { mockAuto, markQuit, dbSetSettings, handlers } = vi.hoisted(() => {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const mockAuto = {
        autoDownload: true,
        autoInstallOnAppQuit: true,
        logger: null as unknown,
        on: (ev: string, h: (...a: unknown[]) => void) => {
            handlers.set(ev, h);
        },
        checkForUpdates: vi.fn(),
        downloadUpdate: vi.fn(async () => {}),
        quitAndInstall: vi.fn(),
    };
    return { mockAuto, markQuit: vi.fn(), dbSetSettings: vi.fn(), handlers };
});

vi.mock('../../db', () => ({ setSettings: dbSetSettings }));
vi.mock('electron-updater', () => ({ autoUpdater: mockAuto }));
vi.mock('electron', () => ({
    app: { getVersion: () => '1.0.0', isPackaged: true },
    net: { fetch: vi.fn(async () => ({ ok: false, json: async () => [] })) },
}));
vi.mock('../quit-state', () => ({
    markQuittingForUpdate: markQuit,
    isQuittingForUpdate: () => false,
}));
vi.mock('../update-surface', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../update-surface')>();
    return { ...actual, appImageUpdateUnavailable: () => false };
});

async function fresh() {
    vi.resetModules();
    const mod = await import('../auto-updater');
    return mod.autoUpdaterInstance();
}

/** Drive the real state machine to a downloaded build the user asked for. */
async function downloadAndLand(u: Awaited<ReturnType<typeof fresh>>): Promise<void> {
    mockAuto.checkForUpdates.mockResolvedValue({
        updateInfo: { version: '2.0.0', releaseDate: '2026-01-01' },
    });
    await u.checkForUpdate();
    const inflight = u.downloadAndInstall();
    handlers.get('update-downloaded')?.({ version: '2.0.0' });
    await inflight;
}

beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
});

describe('restartAndApply — the pre-apply seam', () => {
    it('runs the hook BEFORE it marks the quit and hands over to the installer', async () => {
        const u = await fresh();
        const order: string[] = [];
        markQuit.mockImplementation(() => order.push('markQuit'));
        mockAuto.quitAndInstall.mockImplementation(() => order.push('quitAndInstall'));
        u.setBeforeApply(() => order.push('beforeApply'));

        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0', releaseDate: '2026-01-01' },
        });
        await u.checkForUpdate();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        u.restartAndApply();

        // Ordering is the whole point: the roster must be written while the
        // agents, sites and processes it records are still running.
        expect(order).toEqual(['beforeApply', 'markQuit', 'quitAndInstall']);
    });

    it('runs the hook on the HANDS-FREE finish — the path the owner actually took', async () => {
        // One "Update" click on a machine whose host is expected to survive:
        // the interruption probe reports nothing live, so `update-downloaded`
        // applies immediately with no drain and no pill. This is the door
        // genie#551 escaped through.
        const u = await fresh();
        const beforeApply = vi.fn();
        u.setBeforeApply(beforeApply);
        u.setInterruptionProbe(() => ({ terminals: 0, agentChats: 0 }));

        await downloadAndLand(u);

        expect(mockAuto.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(beforeApply).toHaveBeenCalledTimes(1);
    });

    it('applies anyway when the hook throws — a roster is not worth a wedged upgrade', async () => {
        const u = await fresh();
        u.setBeforeApply(() => {
            throw new Error('the database is locked');
        });

        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0', releaseDate: '2026-01-01' },
        });
        await u.checkForUpdate();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        expect(() => u.restartAndApply()).not.toThrow();
        expect(mockAuto.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it('still refuses to apply a build that was never downloaded', async () => {
        // POSITIVE CONTROL for the guard the hook now sits in front of: the hook
        // must not become a way past `state !== 'ready-to-restart'`.
        const u = await fresh();
        const beforeApply = vi.fn();
        u.setBeforeApply(beforeApply);

        expect(() => u.restartAndApply()).toThrow(/No update has been downloaded/i);
        expect(beforeApply).not.toHaveBeenCalled();
        expect(mockAuto.quitAndInstall).not.toHaveBeenCalled();
    });

    it('applies with no hook registered at all', async () => {
        // POSITIVE CONTROL: the seam is optional, and its absence is not an error.
        const u = await fresh();
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0', releaseDate: '2026-01-01' },
        });
        await u.checkForUpdate();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        u.restartAndApply();
        expect(mockAuto.quitAndInstall).toHaveBeenCalledTimes(1);
    });
});
