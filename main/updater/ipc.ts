import { BrowserWindow, ipcMain } from 'electron';
import { updater, type UpdaterConfig, type UpdaterStatus } from './git-updater';
import {
    autoUpdaterInstance,
    updaterMode,
    type AutoUpdaterStatus,
} from './auto-updater';
import { getAllSettings, setSettings } from '../db';

/**
 * Unified IPC for the updater. The renderer doesn't know whether it's
 * talking to the Phase 1 (git-pull) or Phase 2 (electron-updater)
 * backend — both expose the same channels and a status object the UI
 * can render the same way.
 *
 * Channels (renderer → main):
 *   updater:mode           () → 'phase1' | 'phase2'
 *   updater:status         () → unified status payload
 *   updater:check          () → status after a fresh check
 *   updater:apply          () → { ok }; for phase2 this STAGES the
 *                              installer; restart is a separate call
 *   updater:restart        () → relaunches Genie into the new installer
 *                              (phase2 only — noop on phase1, since
 *                              phase1 has its own "Restart" via app.quit)
 *   updater:config:get     () → UpdaterConfig (phase1 only meaningful)
 *   updater:config:set     (patch) → UpdaterConfig
 *
 * Push events:
 *   updater:status   {status}     — every state change in either backend
 *   updater:log      {line}       — log lines from the active backend
 */
export function registerUpdaterIpc(): void {
    const mode = updaterMode();

    // Hydrate persisted phase1 config either way — even in phase2 we'd
    // surface the source-repo field as a read-only "currently tracking
    // <repo>" line in Settings.
    const settings = getAllSettings() as unknown as Record<string, string>;
    const repo = settings.updater_repo ?? 'renaissance-analytics/genie';
    const pollHours = Number(settings.updater_poll_hours ?? 6);

    const u = updater();
    u.setConfig({ repo, pollHours: Number.isFinite(pollHours) ? pollHours : 6 });
    if (mode === 'phase1') u.startPolling();

    const a = autoUpdaterInstance();

    ipcMain.handle('updater:mode', () => mode);

    ipcMain.handle('updater:status', (): UpdaterStatus | AutoUpdaterStatus => {
        return mode === 'phase1' ? u.getStatus() : a.getStatus();
    });

    ipcMain.handle('updater:check', async (): Promise<unknown> => {
        if (mode === 'phase1') {
            await u.checkForUpdate();
            return u.getStatus();
        }
        await a.checkForUpdate();
        return a.getStatus();
    });

    ipcMain.handle(
        'updater:apply',
        async (): Promise<{ ok: boolean; error?: string }> => {
            try {
                if (mode === 'phase1') await u.applyUpdate();
                else await a.downloadAndStage();
                return { ok: true };
            } catch (e) {
                return {
                    ok: false,
                    error: e instanceof Error ? e.message : String(e),
                };
            }
        },
    );

    ipcMain.handle('updater:restart', (): { ok: boolean; error?: string } => {
        if (mode === 'phase1') {
            // Phase 1's "restart" is just app.quit + user re-launch — the
            // Settings UI has a separate path for this via app.quit. We
            // could automate but it's a separate IPC.
            return { ok: false, error: 'Phase 1 updater does not handle restart here.' };
        }
        try {
            a.restartAndApply();
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    });

    ipcMain.handle('updater:config:get', (): UpdaterConfig => u.getConfig());
    ipcMain.handle(
        'updater:config:set',
        (_e, patch: Partial<UpdaterConfig>): UpdaterConfig => {
            u.setConfig(patch);
            const next = u.getConfig();
            setSettings({
                updater_repo: next.repo,
                updater_poll_hours: String(next.pollHours),
            } as unknown as Record<string, string>);
            return next;
        },
    );

    // Status + log fanout. Both backends emit the same events.
    u.on('status', (status) => broadcastStatus(status));
    u.on('log', (line: string) => broadcastLog(line));
    a.on('status', (status) => broadcastStatus(status));
    a.on('log', (line: string) => broadcastLog(line));
}

function broadcastStatus(status: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('updater:status', status);
    }
}
function broadcastLog(line: string): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('updater:log', { line });
    }
}
