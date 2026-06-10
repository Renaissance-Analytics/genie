import { BrowserWindow, ipcMain } from 'electron';
import { updater, type UpdaterConfig, type UpdaterStatus } from './git-updater';
import { getAllSettings, setSettings } from '../db';

/**
 * IPC layer for the Phase 1 git-pull updater. Channels:
 *
 *   updater:status         () → UpdaterStatus
 *   updater:check          () → UpdaterStatus (kicks a fresh poll)
 *   updater:apply          () → { ok: boolean, error?: string }
 *   updater:config:get     () → UpdaterConfig
 *   updater:config:set     (patch: Partial<UpdaterConfig>) → UpdaterConfig
 *
 * Push events:
 *   updater:status   {UpdaterStatus}        — emitted on every state change
 *   updater:log      {line: string}          — emitted on each log line
 */
export function registerUpdaterIpc(): void {
    const u = updater();

    // Hydrate config from the settings table so the user's previously-saved
    // repo + poll interval survives restart. The default repo points at
    // the canonical public Genie at `renaissance-analytics/genie`; the
    // user can override in Settings if they're tracking a fork.
    const settings = getAllSettings() as unknown as Record<string, string>;
    const repo = settings.updater_repo ?? 'renaissance-analytics/genie';
    const pollHours = Number(settings.updater_poll_hours ?? 6);
    u.setConfig({ repo, pollHours: Number.isFinite(pollHours) ? pollHours : 6 });
    u.startPolling();

    ipcMain.handle('updater:status', (): UpdaterStatus => u.getStatus());
    ipcMain.handle('updater:check', async (): Promise<UpdaterStatus> => {
        await u.checkForUpdate();
        return u.getStatus();
    });
    ipcMain.handle('updater:apply', async (): Promise<{ ok: boolean; error?: string }> => {
        try {
            await u.applyUpdate();
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

    u.on('status', (status: UpdaterStatus) => {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('updater:status', status);
        }
    });
    u.on('log', (line: string) => {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('updater:log', { line });
        }
    });
}
