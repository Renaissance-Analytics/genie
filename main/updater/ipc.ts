import { BrowserWindow, ipcMain, Notification } from 'electron';
import { updater, type UpdaterConfig, type UpdaterStatus } from './git-updater';
import {
    autoUpdaterInstance,
    updaterMode,
    type AutoUpdaterStatus,
} from './auto-updater';
import { getAllSettings, setSettings } from '../db';
import { setUpdateAvailable } from '../tray';
import { showSettingsWindow } from '../background';
import { getChangelog, type Changelog } from './changelog';
import { hostBackendKind, detachedHostPinsBinary } from '../terminal/host-service';
import { mobileEmit } from '../mobile/bus';

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
 *   updater:apply          () → { ok }; for phase2 this is the one-click
 *                              "Update" — downloads the available build and,
 *                              the moment it lands, applies it hands-free
 *                              (download → install → restart, no 2nd click)
 *   updater:restart        () → relaunches Genie into the new installer
 *                              (phase2 only — noop on phase1, since
 *                              phase1 has its own "Restart" via app.quit).
 *                              Mostly a fallback now: the one-click apply
 *                              path already restarts on download-complete
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

    const a = autoUpdaterInstance();

    // Kick off automatic checks for the ACTIVE backend. Packaged builds
    // (phase2) previously never auto-polled — updates only showed after a
    // manual "Check for updates" click. Now both backends check at
    // startup + on an interval, and the status they emit drives the tray
    // badge / notification / banner via reflectUpdateState below.
    if (mode === 'phase1') {
        u.startPolling();
    } else {
        a.startPolling(Number.isFinite(pollHours) ? pollHours : 6);
    }

    ipcMain.handle('updater:mode', () => mode);

    ipcMain.handle('updater:status', () => {
        return withHostFlag(mode === 'phase1' ? u.getStatus() : a.getStatus());
    });

    ipcMain.handle('updater:check', async (): Promise<unknown> => {
        if (mode === 'phase1') {
            await u.checkForUpdate();
            return withHostFlag(u.getStatus());
        }
        await a.checkForUpdate();
        return withHostFlag(a.getStatus());
    });

    ipcMain.handle(
        'updater:apply',
        async (): Promise<{ ok: boolean; error?: string }> => {
            try {
                if (mode === 'phase1') await u.applyUpdate();
                else await a.downloadAndInstall();
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

    ipcMain.handle(
        'updater:changelog',
        async (_e, latest: string): Promise<Changelog> => getChangelog(latest),
    );

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

    // Status + log fanout. Both backends emit the same events. The mobileEmit
    // mirrors the compact update state to a paired phone's /ws/events so the
    // "Upgrade Genie" tool tracks the same state machine live (no-op when the
    // mobile server is off).
    u.on('status', (status) => {
        broadcastStatus(withHostFlag(status));
        reflectUpdateState(status as UpdaterStatus);
        mobileEmit('update:changed', compactUpdate(status as UpdaterStatus));
    });
    u.on('log', (line: string) => broadcastLog(line));
    a.on('status', (status) => {
        broadcastStatus(withHostFlag(status));
        reflectUpdateState(status as AutoUpdaterStatus);
        mobileEmit('update:changed', compactUpdate(status as AutoUpdaterStatus));
    });
    a.on('log', (line: string) => broadcastLog(line));
}

/**
 * The compact update snapshot the mobile "Upgrade Genie" tool reads — just the
 * fields a phone needs to render "up to date" vs "update ready → tap to restart".
 * `state` rides the wire as a plain string (the renderer + phone treat it loosely).
 */
export interface MobileUpdateStatus {
    state: string;
    currentVersion: string;
    latestVersion: string | null;
    /** True only when a build has finished downloading and a restart will apply it. */
    readyToInstall: boolean;
}

function compactUpdate(status: UpdaterStatus | AutoUpdaterStatus): MobileUpdateStatus {
    return {
        state: status.state,
        currentVersion: status.currentVersion,
        latestVersion: status.latestVersion,
        readyToInstall: status.state === 'ready-to-restart',
    };
}

/** Snapshot of the ACTIVE updater backend for the mobile dashboard. */
export function mobileUpdateStatus(): MobileUpdateStatus {
    const status =
        updaterMode() === 'phase1'
            ? updater().getStatus()
            : autoUpdaterInstance().getStatus();
    return compactUpdate(status);
}

/**
 * Trigger a check on the ACTIVE backend, then return the fresh compact status.
 * The host never auto-downloads (no background staging), so a pending update has
 * no state for the phone/remote to read until the host is asked to LOOK — this is
 * that ask. Mirrors the desktop `updater:check` handler.
 */
export async function mobileCheckUpdate(): Promise<MobileUpdateStatus> {
    if (updaterMode() === 'phase1') {
        const u = updater();
        await u.checkForUpdate();
        return compactUpdate(u.getStatus());
    }
    const a = autoUpdaterInstance();
    await a.checkForUpdate();
    return compactUpdate(a.getStatus());
}

/**
 * Apply an update from the phone — the SAME one-click hands-free path the
 * desktop "Update" button uses. Two valid entry states (we never auto-download
 * in the background, so a build is rarely pre-staged):
 *   • 'available'        → downloadAndInstall(): download the build then apply
 *     it the instant it lands (→ restartAndApply → quitAndInstall).
 *   • 'ready-to-restart' → restartAndApply() directly (build already on disk).
 * Anything else reports `not-ready` so the REST layer answers 409. Phase-1 (git
 * checkout) has no installer → `unsupported`. The action is deferred a tick by
 * the caller so the REST response flushes to the phone before teardown begins.
 */
export function mobileInstallUpdate(): {
    ok: boolean;
    error?: string;
    reason?: 'not-ready' | 'unsupported';
} {
    if (updaterMode() === 'phase1') {
        return {
            ok: false,
            reason: 'unsupported',
            error: 'Update install is only available in packaged builds.',
        };
    }
    const a = autoUpdaterInstance();
    const state = a.getStatus().state;
    if (state !== 'available' && state !== 'ready-to-restart') {
        return {
            ok: false,
            reason: 'not-ready',
            error: 'No update is available to install yet.',
        };
    }
    // Defer so the caller's HTTP 200 reaches the phone before the app starts the
    // download / tears down for the installer. From 'available' we download then
    // auto-apply (one hands-free flow); from 'ready-to-restart' we apply now.
    setTimeout(() => {
        try {
            if (state === 'available') void a.downloadAndInstall().catch(() => {});
            else a.restartAndApply();
        } catch {
            /* surfaced via the status stream if it ever throws here */
        }
    }, 200);
    return { ok: true };
}

/**
 * Decorate a status payload with whether APPLYING an update will restart the
 * pty-host. This is true for EXACTLY ONE backend kind:
 *
 *   • 'detached' → the host is Genie's execPath child, so it PINS the binary.
 *     The update teardown must snapshot + KILL it (so NSIS can overwrite the
 *     binary), which means any running detached terminals restart from a
 *     snapshot. The update pill warns the user BEFORE they apply so they can
 *     save/close live sessions first. → flag TRUE.
 *   • 'service'  → the host runs on its OWN standalone Node runtime via the OS
 *     service, never pins Genie's binary, and SURVIVES the update seamlessly
 *     (Genie reconnects after the swap, terminals live). → flag FALSE, no warn.
 *   • 'inprocess' → no detached host at all. → flag FALSE.
 *
 * So the flag is `hostBackendKind() === 'detached'`, NOT plain `isHostBacked()`
 * (which would also be true for a service-backed host that DOESN'T restart).
 */
export function withHostFlag(
    status: UpdaterStatus | AutoUpdaterStatus,
): (UpdaterStatus | AutoUpdaterStatus) & { willRestartPtyHost: boolean } {
    let willRestartPtyHost = false;
    try {
        // A detached host only restarts on update if it PINS Genie's binary —
        // i.e. it was launched as Genie's execPath child. A detached host on the
        // shipped standalone Node survives the update like the service does.
        willRestartPtyHost =
            hostBackendKind() === 'detached' && detachedHostPinsBinary();
    } catch {
        /* defensive: never let the host probe break the status payload */
    }
    return { ...status, willRestartPtyHost };
}

/**
 * Update-available UX, driven off the same status stream the renderer
 * gets: swap the tray icon to the badged variant, and fire ONE native
 * notification per discovered version (re-checks every pollHours would
 * otherwise re-toast the same release all day). Cleared whenever the
 * backend reports anything that isn't available/staging/ready.
 */
let notifiedVersion: string | null = null;
function reflectUpdateState(status: UpdaterStatus | AutoUpdaterStatus): void {
    const pending =
        status.state === 'available' ||
        status.state === 'downloading' ||
        status.state === 'applying' ||
        status.state === 'ready-to-restart';

    setUpdateAvailable(pending ? status.latestVersion : null);

    if (
        status.state === 'available' &&
        status.latestVersion &&
        status.latestVersion !== notifiedVersion &&
        Notification.isSupported()
    ) {
        notifiedVersion = status.latestVersion;
        const n = new Notification({
            title: `Genie v${status.latestVersion} is available`,
            body: 'Click to open Settings and install the update.',
            silent: true,
        });
        n.on('click', () => showSettingsWindow());
        n.show();
    }
}

/**
 * Run a check on the ACTIVE backend, throttled so opening/focusing the
 * window repeatedly doesn't hammer GitHub. Called when the master window
 * is shown — Genie is tray-resident, so the startup poll often fires
 * while no window is open (and the native toast can be swallowed by
 * Windows Focus Assist). Checking on window-show guarantees the header
 * pill is current the moment the user actually looks at Genie.
 */
let lastCheckAt = 0;
export function checkForUpdatesNow(force = false): void {
    const now = Date.now();
    if (!force && now - lastCheckAt < 2 * 60 * 1000) return;
    lastCheckAt = now;
    const mode = updaterMode();
    if (mode === 'phase1') void updater().checkForUpdate().catch(() => {});
    else void autoUpdaterInstance().checkForUpdate().catch(() => {});
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
