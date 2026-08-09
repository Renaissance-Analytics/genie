import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #127 — the Update tab reported "you're on the latest version" while the
 * RUNNING Genie process was OLDER than the build electron-updater had already
 * downloaded/installed on disk.
 *
 * Once `update-downloaded` fires, a newer build is staged and the RUNNING
 * process keeps executing the OLD code until a restart applies it. A later check
 * whose feed-latest matches what is now ON DISK — so `app.getVersion()` has
 * advanced to it — must therefore keep surfacing a RESTART-PENDING state, never
 * "up to date". The running process is what the user is actually on.
 *
 * `installedVersion` is mutable so a test can advance the ON-DISK install (what
 * `app.getVersion()` reports) independently of the version the RUNNING process
 * was constructed with — the exact drift that produced the false "latest".
 */

let installedVersion = '0.7.0-beta.231';

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
    // getVersion() reflects the ON-DISK install — it can drift ahead of the
    // running process after electron-updater applies a staged build.
    app: { getVersion: () => installedVersion, isPackaged: true },
    net: { fetch: vi.fn(async () => ({ ok: false, json: async () => [] })) },
}));
vi.mock('../quit-state', () => ({
    markQuittingForUpdate: markQuit,
    isQuittingForUpdate: () => false,
}));
// Keep the electron-updater branch under test OS-deterministic (see update-flow
// test): otherwise a CI Linux runner diverts to the manual-download fallback.
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
    installedVersion = '0.7.0-beta.231';
});

describe('#127 running < downloaded build → restart-pending, never "latest"', () => {
    it('keeps restart-pending after the on-disk install advances to the downloaded build', async () => {
        const u = await fresh(); // RUNNING version captured = beta.231

        // electron-updater downloads beta.232 and stages it for the next restart.
        handlers.get('update-downloaded')?.({ version: '0.7.0-beta.232' });
        expect(u.getStatus().state).toBe('ready-to-restart');

        // The NSIS install advances the ON-DISK build to beta.232, so
        // app.getVersion() now reports beta.232 — but the RUNNING process is
        // still executing beta.231.
        installedVersion = '0.7.0-beta.232';

        // A periodic re-check runs; the feed's latest is beta.232 (== on disk).
        mockAuto.checkForUpdates.mockResolvedValue({
            updateInfo: { version: '0.7.0-beta.232' },
        });
        await u.checkForUpdate();

        // The running process is OLDER than the downloaded build, so the Update
        // tab must surface "restart to finish updating", NOT "you're on the
        // latest version".
        expect(u.getStatus().state).toBe('ready-to-restart');
        expect(u.getStatus().latestVersion).toBe('0.7.0-beta.232');
    });

    it('re-detecting the staged build DURING a check (cached update-downloaded) does not settle to up-to-date', async () => {
        // The process started already lagging: on-disk is beta.232 from a prior
        // session's install, but the RUNNING process is beta.231.
        const u = await fresh(); // running captured = beta.231
        installedVersion = '0.7.0-beta.232';

        // electron-updater, on check, re-detects the cached staged build and
        // re-emits update-downloaded, THEN resolves the check as "current"
        // (feed == on-disk). The resolution must not clobber restart-pending.
        mockAuto.checkForUpdates.mockImplementation(async () => {
            handlers.get('update-downloaded')?.({ version: '0.7.0-beta.232' });
            return { updateInfo: { version: '0.7.0-beta.232' } };
        });
        await u.checkForUpdate();

        expect(u.getStatus().state).toBe('ready-to-restart');
        expect(u.getStatus().latestVersion).toBe('0.7.0-beta.232');
    });
});
