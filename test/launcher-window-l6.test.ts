import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installScreen } from '../src/core/install-screen.js';
import { updateChip } from '../src/core/update-chip.js';
import { launcherUpdaterPort } from '../src/main/launcher-updates.js';
import { UpdatesReplica } from '../src/main/updates-replica.js';
import { UpdateHost } from '../src/main/updater.js';

/**
 * THE CLIENT WINDOW UNDER THE LAUNCHER (Tynn #1058 L6; the coordinator's review of the Windows shots, 1127-161005-982226).
 *  1. The title bar's update pill said "Genie 2026.11.27-2 is available — download": the person never downloads anything
 *     (the owner), and it competed with the launcher's own offer. Under the launcher it says "Updates (N)" and opens the
 *     launcher's Updates window (`updates.openLauncher` -> `launcher.openUpdates`). With no launcher it is as before.
 *  2. Behind the launcher's "Updating the host" card the window showed its own restart screen (genie#1201) for the whole
 *     drain. Under the launcher the window leaves as soon as the host starts installing (the launcher's card says how it
 *     goes, and Genie is opened again after the swap), and never draws that screen.
 */
const src = (file: string) => readFileSync(file, 'utf8');
const AVAILABLE = { phase: 'available' as const, version: '2026.11.27-2', percent: null };

describe('the title bar’s update pill', () => {
    it('under the launcher: "Updates (N)", which opens the launcher’s Updates window', () => {
        expect(updateChip({ ...AVAILABLE, launcher: { ready: 3 } })).toMatchObject({ phase: 'available', label: 'Updates (3)', action: 'launcher-updates' });
        expect(updateChip({ ...AVAILABLE, phase: 'downloaded', launcher: { ready: 1 } })).toMatchObject({ label: 'Updates (1)', action: 'launcher-updates' });
    });

    it('with no launcher (the bridge release), as before', () => {
        expect(updateChip(AVAILABLE)).toMatchObject({ label: 'Genie 2026.11.27-2 is available — download', action: 'update-download' });
    });

    it('the launcher’s port says how many are ready, and UpdateHost carries it to every window', async () => {
        const rows = [
            { track: 'host', current: '2026.11.27-1', state: 'ready', offer: { build: '2026.11.27-2' } },
            { track: 'client', current: '2026.11.27-1', state: 'ready', offer: { build: '2026.11.27-2' } },
            { track: 'browser', current: '2026.11.27-1', state: 'up-to-date', offer: null },
        ];
        const call = async (method: string) => (method === 'launcher.check' ? { ok: true as const, value: { tracks: rows } } : { ok: true as const, value: null });
        const port = launcherUpdaterPort(call, 7);
        const found = await port.check();
        expect(found && 'launcher' in found ? found.launcher : null).toEqual({ ready: 2 });
        const host = new UpdateHost({ installDir: '/opt/genie', ownPid: 10, processes: () => [], kill: () => true, caseInsensitive: false, running: { build: '2026.11.27-1', protocol: 4 }, port });
        await host.check();
        expect((host.state() as { launcher?: unknown }).launcher).toEqual({ ready: 2 });
    });

    it('wired: the pill’s action asks the host, which asks the launcher (a local window’s method only)', () => {
        expect(src('src/renderer/Shell.tsx')).toMatch(/action === 'launcher-updates'\) void updates\.openLauncher\?\.\(\)/);
        expect(src('src/renderer/remote-bridge.ts')).toContain("openLauncher: () => read<boolean>('updates.openLauncher')");
        expect(src('src/main/host-api.ts')).toMatch(/case 'updates\.openLauncher':\n\s*return deps\.updates\?\.openLauncher\?\.\(\) \?\? false;/);
        expect(src('src/core/remote-protocol.ts')).toMatch(/'updates\.openLauncher': 'local',/);
        expect(src('src/main/genie-host.ts')).toMatch(/callLauncher\(launcherForUpdates, 'launcher\.openUpdates'/);
    });
});

describe('the window while the host installs, under the launcher', () => {
    const INSTALLING = { phase: 'installing' as const, version: '2026.11.27-2', percent: 100, error: null, checkedAt: 1, installing: { step: 'waiting' as const, agents: 3, left: 3 } };

    it('the window is told at the install’s START, so it leaves before the drain; with no launcher only at its restart', () => {
        const told: unknown[] = [];
        const early = new UpdatesReplica(async () => null, 1);
        expect(typeof (early as { tellAtStart?: unknown }).tellAtStart).toBe('function');
        (early as unknown as { tellAtStart: () => void }).tellAtStart();
        early.onInstalling((scope) => { told.push(scope ?? 'none'); });
        early.rebase(INSTALLING);
        expect(told).toHaveLength(1);
        const late: unknown[] = [];
        const before = new UpdatesReplica(async () => null, 1);
        before.onInstalling((scope) => { late.push(scope ?? 'none'); });
        before.rebase(INSTALLING);
        expect(late).toHaveLength(0);
    });

    it('main.ts asks for it when a launcher started the window', () => {
        expect(src('src/main/main.ts')).toMatch(/if \(launcherLink\(process\.env\) !== null\) replica\.tellAtStart\(\);/);
    });

    it('the restart screen is never drawn under the launcher; with no launcher it is', () => {
        expect(installScreen({ ...INSTALLING, launcher: { ready: 1 } }, true)).toBeNull();
        expect(installScreen(INSTALLING, true)).not.toBeNull();
    });
});
