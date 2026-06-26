import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The packaged-app updater's HANDS-OFF behaviour: once a check finds a newer
 * release it must start downloading in the BACKGROUND on its own (so the only
 * click the user ever makes is "Restart to update"), and a routine re-check must
 * NOT disturb an in-flight download or an already-staged build. Install always
 * stays explicit (restartAndApply → markQuittingForUpdate → quitAndInstall).
 *
 * We mock `electron-updater`'s autoUpdater + electron's `app` so the state
 * machine runs in plain Node, and re-import the module per test (vi.resetModules)
 * to get a fresh singleton each time.
 */

const { mockAuto, markQuit, handlers } = vi.hoisted(() => {
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
    return { mockAuto, markQuit: vi.fn(), handlers };
});

vi.mock('electron-updater', () => ({ autoUpdater: mockAuto }));
vi.mock('electron', () => ({
    app: { getVersion: () => '1.0.0', isPackaged: true },
}));
vi.mock('../quit-state', () => ({
    markQuittingForUpdate: markQuit,
    isQuittingForUpdate: () => false,
}));

async function fresh() {
    vi.resetModules();
    const mod = await import('../auto-updater');
    return mod.autoUpdaterInstance();
}

beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
});

describe('auto-updater hands-off download', () => {
    it('starts a background download the moment an update is found', async () => {
        const u = await fresh();
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0', releaseDate: '2026-01-01' },
        });

        await u.checkForUpdate();

        // No click needed — downloadAndStage fired itself and we're downloading.
        expect(mockAuto.downloadUpdate).toHaveBeenCalledTimes(1);
        expect(u.getStatus().state).toBe('downloading');
        expect(u.getStatus().latestVersion).toBe('2.0.0');
    });

    it('does NOT auto-download when hands-off mode is turned off', async () => {
        const u = await fresh();
        u.setAutoDownload(false);
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0' },
        });

        await u.checkForUpdate();

        expect(mockAuto.downloadUpdate).not.toHaveBeenCalled();
        expect(u.getStatus().state).toBe('available');
    });

    it('reports up-to-date (and no download) when already on the latest', async () => {
        const u = await fresh();
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '1.0.0' },
        });

        await u.checkForUpdate();

        expect(u.getStatus().state).toBe('up-to-date');
        expect(mockAuto.downloadUpdate).not.toHaveBeenCalled();
    });

    it('a routine re-check is a no-op once a build is staged (no re-download)', async () => {
        const u = await fresh();
        // Simulate electron-updater finishing the download → ready-to-restart.
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        expect(u.getStatus().state).toBe('ready-to-restart');

        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '3.0.0' },
        });
        await u.checkForUpdate();

        // The poll must not re-enter checking / kick a second download.
        expect(mockAuto.checkForUpdates).not.toHaveBeenCalled();
        expect(u.getStatus().state).toBe('ready-to-restart');
    });

    it('restartAndApply marks the update quit and calls quitAndInstall', async () => {
        const u = await fresh();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });

        u.restartAndApply();

        expect(markQuit).toHaveBeenCalledTimes(1);
        expect(mockAuto.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('restartAndApply throws when no build has been downloaded yet', async () => {
        const u = await fresh();
        expect(() => u.restartAndApply()).toThrow();
        expect(mockAuto.quitAndInstall).not.toHaveBeenCalled();
    });
});
