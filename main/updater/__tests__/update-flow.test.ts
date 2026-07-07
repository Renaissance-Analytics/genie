import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The packaged-app updater's flow. "Auto-update" here means HANDS-FREE on the
 * user's click, NOT download-behind-their-back:
 *
 *   1. A check (manual button OR periodic poll) finds the LATEST release and
 *      surfaces it as 'available'. It does NOT download anything.
 *   2. The user clicks "Update" → downloadAndInstall() downloads the build and,
 *      the instant it lands, applies it hands-free (markQuittingForUpdate →
 *      quitAndInstall(true, true) — silent oneClick installer, relaunch after).
 *
 * The bug this guards against: once a build was staged ('ready-to-restart') the
 * updater used to go DEAD — every later check (the manual button included) was a
 * no-op, so a newer release (beta.59 over a staged beta.58) was never picked up.
 * A check must always re-check over a staged build and advance to the latest.
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
    // auto-updater imports `net` for the manual-download fallback. Stub it so the
    // module's `import { app, net }` is complete — an incomplete mock left `net`
    // undefined, and on Linux the fallback's `net.fetch(...)` then threw.
    net: { fetch: vi.fn(async () => ({ ok: false, json: async () => [] })) },
}));
vi.mock('../quit-state', () => ({
    markQuittingForUpdate: markQuit,
    isQuittingForUpdate: () => false,
}));
// These tests cover the ACTIVE electron-updater path (checkForUpdates /
// downloadUpdate). On a CI Linux runner the production code would otherwise
// detect "AppImage updater inert" (process.platform === 'linux', isPackaged,
// APPIMAGE unset) and divert to the GitHub manual-download fallback — a DIFFERENT
// state machine that never reaches 'available'. That platform divergence (not
// reproducible on the Windows/macOS dev boxes) was the CI-ONLY red: every
// 'available'-expecting assertion saw 'up-to-date', and the in-flight test's
// fire-and-forget then threw its state guard as an unhandled rejection that
// polluted the whole suite. Pin the branch under test so it's OS-deterministic.
vi.mock('../update-surface', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../update-surface')>();
    return { ...actual, appImageUpdateUnavailable: () => false };
});

async function fresh() {
    vi.resetModules();
    const mod = await import('../auto-updater');
    return mod.autoUpdaterInstance();
}

beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
});

describe('auto-updater check (surfaces, never auto-downloads)', () => {
    it('surfaces a newer release as available WITHOUT downloading it', async () => {
        const u = await fresh();
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0', releaseDate: '2026-01-01' },
        });

        await u.checkForUpdate();

        // "Auto-update" is hands-FREE on click, not download-behind-their-back.
        expect(u.getStatus().state).toBe('available');
        expect(u.getStatus().latestVersion).toBe('2.0.0');
        expect(mockAuto.downloadUpdate).not.toHaveBeenCalled();
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
});

describe('auto-updater re-check over a staged build (the bug)', () => {
    it('re-checks when a build is already staged and supersedes it with a newer version', async () => {
        const u = await fresh();
        // A build (2.0.0) finished downloading and is staged, ready to apply.
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        expect(u.getStatus().state).toBe('ready-to-restart');

        // A newer release (3.0.0) is now published. The manual "Check for
        // updates" button (and the periodic poll) MUST re-check over the staged
        // 2.0.0 and surface 3.0.0 — not sit dead on the stale build forever.
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '3.0.0' },
        });
        await u.checkForUpdate();

        expect(mockAuto.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(u.getStatus().state).toBe('available');
        expect(u.getStatus().latestVersion).toBe('3.0.0');
    });

    it('the Update button then installs the SUPERSEDING version, not the stale staged one', async () => {
        const u = await fresh();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });

        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '3.0.0' },
        });
        await u.checkForUpdate();
        expect(u.getStatus().latestVersion).toBe('3.0.0');

        // One click: download the freshly-found 3.0.0 then apply it hands-free.
        await u.downloadAndInstall();
        expect(mockAuto.downloadUpdate).toHaveBeenCalledTimes(1);
        expect(u.getStatus().state).toBe('downloading');

        handlers.get('update-downloaded')?.({ version: '3.0.0' });
        expect(u.getStatus().latestVersion).toBe('3.0.0');
        expect(markQuit).toHaveBeenCalledTimes(1);
        expect(mockAuto.quitAndInstall).toHaveBeenCalledWith(true, true);
    });

    it('keeps a staged build (no re-download, no flapping) when it is still the latest', async () => {
        const u = await fresh();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        expect(u.getStatus().state).toBe('ready-to-restart');

        // The re-check finds the SAME version that's already staged.
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0' },
        });
        await u.checkForUpdate();

        // We DID re-check (the button isn't dead), but we didn't pointlessly
        // re-download the build we're already holding, and we stay ready.
        expect(mockAuto.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(mockAuto.downloadUpdate).not.toHaveBeenCalled();
        expect(u.getStatus().state).toBe('ready-to-restart');
        expect(u.getStatus().latestVersion).toBe('2.0.0');
    });

    it('keeps the staged build if a re-check fails (e.g. offline)', async () => {
        const u = await fresh();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        expect(u.getStatus().state).toBe('ready-to-restart');

        mockAuto.checkForUpdates.mockRejectedValue(new Error('offline'));
        await u.checkForUpdate();

        // A flaky network on the re-check must not throw away a good staged build.
        expect(u.getStatus().state).toBe('ready-to-restart');
        expect(u.getStatus().latestVersion).toBe('2.0.0');
    });

    it('does NOT re-check while a download is actively in flight', async () => {
        const u = await fresh();
        // Get to 'available', then start the one-click download.
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0' },
        });
        // Hold the download GENUINELY in-flight: downloadUpdate stays pending
        // until we release it, so 'downloading' is real for the whole window the
        // concurrent check runs in (not racing a mock that resolves instantly).
        let releaseDownload!: () => void;
        mockAuto.downloadUpdate.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                releaseDownload = resolve;
            }),
        );
        await u.checkForUpdate();
        // Keep a HANDLE on the download (not a fire-and-forget `void`), so its
        // settlement is awaited and can never leak an unhandled rejection — that
        // unawaited `void` was what polluted the suite on CI.
        const downloading = u.downloadAndInstall();
        expect(u.getStatus().state).toBe('downloading');

        // A check fired while the installer is mid-download must be a no-op —
        // re-entering would race the in-flight download.
        mockAuto.checkForUpdates.mockClear();
        await u.checkForUpdate();
        expect(mockAuto.checkForUpdates).not.toHaveBeenCalled();
        expect(u.getStatus().state).toBe('downloading');

        // Let the download finish and settle its promise — no leaked rejection.
        releaseDownload();
        await downloading;
    });
});

describe('auto-updater one-click hands-free apply', () => {
    it('downloadAndInstall downloads, then applies on download-complete with no second click', async () => {
        const u = await fresh();
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0' },
        });
        await u.checkForUpdate();
        expect(u.getStatus().state).toBe('available');

        // ONE click drives download → install → restart.
        await u.downloadAndInstall();
        expect(mockAuto.downloadUpdate).toHaveBeenCalledTimes(1);
        expect(u.getStatus().state).toBe('downloading');

        // The install fires the instant the build lands — automatically, and
        // EXACTLY ONCE. (The pill's frontend driver must NOT also call restart on
        // this fresh-apply path — see shouldDriveRestart — or quitAndInstall would
        // double-fire. The backend's installWhenReady is the single source here.)
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        expect(markQuit).toHaveBeenCalledTimes(1);
        expect(mockAuto.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(mockAuto.quitAndInstall).toHaveBeenCalledWith(true, true);
    });

    it('downloadAndInstall throws when there is no available update', async () => {
        const u = await fresh();
        await expect(u.downloadAndInstall()).rejects.toThrow();
        expect(mockAuto.downloadUpdate).not.toHaveBeenCalled();
    });

    it('an Upgrade click that races a background re-check WAITS it out and downloads (the wedged-pill bug)', async () => {
        // The wedge: the window-show / poll re-check flips state to 'checking'
        // for the second the user's click lands. Refusing there ("No update
        // available") left the pill committed with nothing driving it —
        // "Upgrading…" forever. The click must instead wait for the check to
        // settle and proceed off its fresh verdict.
        const u = await fresh();
        // Surface the update so the user has an Upgrade button to click.
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0' },
        });
        await u.checkForUpdate();
        expect(u.getStatus().state).toBe('available');

        // A background re-check goes in flight (held pending), exactly when the
        // user clicks Upgrade.
        let releaseCheck!: () => void;
        mockAuto.checkForUpdates.mockReturnValueOnce(
            new Promise((resolve) => {
                releaseCheck = () =>
                    resolve({ updateInfo: { version: '2.0.0' } });
            }),
        );
        const recheck = u.checkForUpdate();
        expect(u.getStatus().state).toBe('checking');

        const clicked = u.downloadAndInstall();
        // Still checking — the click is waiting, not refused.
        expect(mockAuto.downloadUpdate).not.toHaveBeenCalled();

        releaseCheck();
        await recheck;
        await clicked;

        expect(mockAuto.downloadUpdate).toHaveBeenCalledTimes(1);
        expect(u.getStatus().state).toBe('downloading');
    });

    it('the raced click still throws if the settled check finds nothing to install', async () => {
        const u = await fresh();
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '2.0.0' },
        });
        await u.checkForUpdate();

        // The re-check the click races concludes we're already current.
        let releaseCheck!: () => void;
        mockAuto.checkForUpdates.mockReturnValueOnce(
            new Promise((resolve) => {
                releaseCheck = () =>
                    resolve({ updateInfo: { version: '1.0.0' } });
            }),
        );
        const recheck = u.checkForUpdate();
        const clicked = u.downloadAndInstall();
        releaseCheck();
        await recheck;

        await expect(clicked).rejects.toThrow();
        expect(mockAuto.downloadUpdate).not.toHaveBeenCalled();
    });

    it('the check → in-flight download → concurrent check flow leaks no unhandled rejection', async () => {
        // Reproduce the exact flow that went red on CI, under an unhandled-
        // rejection sentinel: if any promise in this path is ever left unhandled
        // again (the regression that polluted the suite), this fails deterministically.
        const leaks: unknown[] = [];
        const onUnhandled = (reason: unknown) => leaks.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            const u = await fresh();
            mockAuto.checkForUpdates.mockResolvedValue({ updateInfo: { version: '2.0.0' } });
            let releaseDownload!: () => void;
            mockAuto.downloadUpdate.mockReturnValueOnce(
                new Promise<void>((resolve) => {
                    releaseDownload = resolve;
                }),
            );
            await u.checkForUpdate();
            const downloading = u.downloadAndInstall();
            await u.checkForUpdate(); // concurrent re-check — must be a no-op
            releaseDownload();
            await downloading;
            // Drain macrotasks so any deferred unhandledRejection would surface.
            await new Promise((r) => setTimeout(r, 0));
            await new Promise((r) => setTimeout(r, 0));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(leaks).toEqual([]);
    });

    it('a download we did NOT initiate just rests at ready-to-restart (never force-quits)', async () => {
        const u = await fresh();
        // Build lands without the user having clicked Update (installWhenReady
        // unset) — we stage it and wait, we do not quit on our own.
        handlers.get('update-downloaded')?.({ version: '2.0.0' });
        expect(u.getStatus().state).toBe('ready-to-restart');
        expect(markQuit).not.toHaveBeenCalled();
        expect(mockAuto.quitAndInstall).not.toHaveBeenCalled();
    });

    it('restartAndApply marks the update quit and calls a silent quitAndInstall', async () => {
        const u = await fresh();
        handlers.get('update-downloaded')?.({ version: '2.0.0' });

        u.restartAndApply();

        expect(markQuit).toHaveBeenCalledTimes(1);
        // Silent (oneClick NSIS, no wizard/UAC), relaunch after.
        expect(mockAuto.quitAndInstall).toHaveBeenCalledWith(true, true);
    });

    it('restartAndApply throws when no build has been downloaded yet', async () => {
        const u = await fresh();
        expect(() => u.restartAndApply()).toThrow();
        expect(mockAuto.quitAndInstall).not.toHaveBeenCalled();
    });
});

describe('isReleasePublishingError (draft/publish-window 404 is not a real error)', () => {
    it('treats a missing latest.yml (404 / cannot-find) as a publishing-window, not an error', async () => {
        const { isReleasePublishingError } = await import('../auto-updater');
        expect(
            isReleasePublishingError(
                'Cannot find latest.yml in the latest release artifacts (https://…/v0.7.0-beta.124/latest.yml): HTTPError: 404',
            ),
        ).toBe(true);
        expect(isReleasePublishingError('HttpError: 404 method: GET url: …/latest.yml')).toBe(true);
        expect(isReleasePublishingError('Cannot find latest-mac.yml')).toBe(true);
    });

    it('does NOT swallow genuine failures (network/offline/other)', async () => {
        const { isReleasePublishingError } = await import('../auto-updater');
        expect(isReleasePublishingError('net::ERR_INTERNET_DISCONNECTED')).toBe(false);
        expect(isReleasePublishingError('getaddrinfo ENOTFOUND github.com')).toBe(false);
        expect(isReleasePublishingError('Error: connect ETIMEDOUT')).toBe(false);
    });
});

describe("auto-updater 'error' EVENT (the leaking path beta.125 missed)", () => {
    it('does NOT surface a mid-publish latest.yml 404 error EVENT — settles to up-to-date', async () => {
        const u = await fresh();
        // electron-updater emits the failed check as an 'error' event too, not
        // just a rejected promise — this is the path that dumped the scary 404.
        handlers.get('error')?.(
            new Error(
                'Cannot find latest.yml in the latest release artifacts (https://github.com/…/v0.7.0-beta.128/latest.yml): HttpError: 404',
            ),
        );
        expect(u.getStatus().state).toBe('up-to-date');
    });

    it('STILL surfaces a genuine error EVENT (e.g. the macOS signature failure)', async () => {
        const u = await fresh();
        handlers.get('error')?.(
            new Error('code has no resources but signature indicates they must be present'),
        );
        expect(u.getStatus().state).toBe('error');
    });
});
