import { app } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { EventEmitter } from 'node:events';
import { markQuittingForUpdate } from './quit-state';

/**
 * Phase 2 packaged-app updater. Wraps `electron-updater` so the
 * renderer surface is identical to the Phase 1 git updater: same
 * state machine, same log stream, same UI. The two updaters never
 * run at the same time — `mode()` below picks one based on whether
 * we're a packaged build or a git checkout.
 *
 * `electron-updater` pulls release artifacts from the publish provider
 * configured in `electron-builder.yml` (GitHub Releases for us). It
 * verifies a SHA-512 checksum from `latest.yml` against the downloaded
 * installer before applying — that, plus the signed installer's own
 * authenticode/notarisation chain, is what makes the auto-update path
 * production-trustworthy.
 *
 * Differences vs Phase 1:
 *   - No `npm install`/`npm run build` step. The new version IS the
 *     installer.
 *   - "Apply" downloads the installer to a staging dir; "Restart"
 *     hands control to it. The current binary is replaced atomically
 *     by the installer's own swap logic on next launch.
 *   - No rollback on failure — electron-updater leaves the previous
 *     install intact and the user can simply not restart.
 */

export type AutoUpdaterState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'downloading'
    | 'ready-to-restart'
    | 'error'
    | 'disabled';

export interface AutoUpdaterStatus {
    state: AutoUpdaterState;
    currentVersion: string;
    latestVersion: string | null;
    publishedAt: string | null;
    releaseUrl: string | null;
    log: string[];
    error: string | null;
    /** 0..1 during 'downloading'. */
    progress: number | null;
    /**
     * Set when auto-update can't complete on THIS platform and the user should
     * download a build manually instead — currently macOS, where Squirrel.Mac
     * rejects an unsigned/ad-hoc build's signature. Points at the GitHub release
     * to download. Null when auto-update is healthy.
     */
    manualDownloadUrl: string | null;
}

const LOG_MAX = 2000;

class AutoUpdater extends EventEmitter {
    private status: AutoUpdaterStatus;
    private timer: NodeJS.Timeout | null = null;

    constructor() {
        super();
        this.status = {
            state: 'idle',
            currentVersion: app.getVersion(),
            latestVersion: null,
            publishedAt: null,
            releaseUrl: null,
            log: [],
            error: null,
            progress: null,
            manualDownloadUrl: null,
        };
        this.bind();
    }

    getStatus(): AutoUpdaterStatus {
        return { ...this.status, log: [...this.status.log] };
    }

    /**
     * Automatic update checks: one shortly after launch (so a release cut
     * while Genie was closed surfaces on next open) then every
     * `intervalHours`. Without this, packaged builds only ever checked
     * when the user hit "Check for updates" — so the tray badge /
     * notification / banner never fired on their own. Each check emits
     * status, which the IPC layer turns into the update-available UX.
     */
    startPolling(intervalHours: number): void {
        this.stopPolling();
        const hours = intervalHours > 0 ? intervalHours : 6;
        // Defer the first check a few seconds so it doesn't compete with
        // window creation / IPC registration on cold start.
        setTimeout(() => void this.checkForUpdate().catch(() => {}), 8000);
        this.timer = setInterval(
            () => void this.checkForUpdate().catch(() => {}),
            hours * 60 * 60 * 1000,
        );
        // Don't hold the event loop open just for the poll.
        this.timer.unref?.();
    }

    stopPolling(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async checkForUpdate(): Promise<void> {
        if (this.status.state === 'downloading') return;
        this.setStatus({ state: 'checking', error: null, manualDownloadUrl: null });
        try {
            const res = await autoUpdater.checkForUpdates();
            if (!res || !res.updateInfo) {
                this.setStatus({ state: 'up-to-date' });
                return;
            }
            const latest = res.updateInfo.version;
            if (latest === app.getVersion()) {
                this.setStatus({
                    state: 'up-to-date',
                    latestVersion: latest,
                });
            } else {
                this.setStatus({
                    state: 'available',
                    latestVersion: latest,
                    publishedAt: res.updateInfo.releaseDate ?? null,
                    releaseUrl: pickReleaseUrl(res.updateInfo),
                });
            }
        } catch (e) {
            this.setStatus({
                state: 'error',
                error: e instanceof Error ? e.message : String(e),
                manualDownloadUrl: this.manualUrlForPlatform(),
            });
        }
    }

    async downloadAndStage(): Promise<void> {
        if (this.status.state !== 'available') {
            throw new Error('No update available to download.');
        }
        this.setStatus({ state: 'downloading', progress: 0, error: null });
        try {
            await autoUpdater.downloadUpdate();
            // Success transitions to 'ready-to-restart' via the
            // `update-downloaded` event handler in bind().
        } catch (e) {
            this.setStatus({
                state: 'error',
                error: e instanceof Error ? e.message : String(e),
                manualDownloadUrl: this.manualUrlForPlatform(),
            });
        }
    }

    restartAndApply(): void {
        if (this.status.state !== 'ready-to-restart') {
            throw new Error('No update has been downloaded yet.');
        }
        // Signal the before-quit teardown that this quit is an UPDATE apply,
        // not a normal quit. With a detached pty-host alive, the host pins
        // Genie's binary (it runs as `execPath` + ELECTRON_RUN_AS_NODE) and
        // NSIS can't overwrite it; the teardown reads this flag to snapshot +
        // KILL the host so the installer can replace the binary. MUST be set
        // BEFORE quitAndInstall so before-quit sees it. (See quit-state.ts.)
        markQuittingForUpdate();
        // `quitAndInstall(isSilent, isForceRunAfter)`:
        //   isSilent=false  — show the installer UI (Windows NSIS)
        //   isForceRunAfter=true — relaunch Genie after install
        autoUpdater.quitAndInstall(false, true);
    }

    private bind(): void {
        // We do everything explicitly — no auto-download, no auto-install.
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false;

        autoUpdater.logger = {
            info: (...args: unknown[]) => this.appendLog('info: ' + args.join(' ')),
            warn: (...args: unknown[]) => this.appendLog('warn: ' + args.join(' ')),
            error: (...args: unknown[]) => this.appendLog('error: ' + args.join(' ')),
            debug: (..._args: unknown[]) => { /* noisy; drop */ },
        };

        autoUpdater.on('update-available', (info) => {
            this.appendLog(`update-available ${info.version}`);
        });
        autoUpdater.on('update-not-available', (info) => {
            this.appendLog(`update-not-available ${info.version}`);
        });
        autoUpdater.on('download-progress', (p) => {
            this.setStatus({
                state: 'downloading',
                progress: Math.max(0, Math.min(1, p.percent / 100)),
            });
        });
        autoUpdater.on('update-downloaded', (info) => {
            this.appendLog(`update-downloaded ${info.version}`);
            this.setStatus({
                state: 'ready-to-restart',
                latestVersion: info.version,
                progress: 1,
            });
        });
        autoUpdater.on('error', (err) => {
            // macOS Squirrel rejects an unsigned/ad-hoc build's signature on
            // apply ("code has no resources but signature indicates they must
            // be present") — there's no in-app recovery, so route the user to a
            // manual download instead of leaving them on a dead error.
            this.setStatus({
                state: 'error',
                error: err?.message ?? String(err),
                manualDownloadUrl: this.manualUrlForPlatform(),
            });
        });
    }

    /**
     * The release to download by hand when auto-update can't apply on this
     * platform (macOS today). Prefers the exact tag once known, else the
     * latest-release page. Returns null on platforms where auto-update works.
     */
    private manualUrlForPlatform(): string | null {
        if (process.platform !== 'darwin') return null;
        const tag = this.status.latestVersion ? `v${this.status.latestVersion}` : null;

        return tag
            ? `https://github.com/Renaissance-Analytics/genie/releases/tag/${tag}`
            : 'https://github.com/Renaissance-Analytics/genie/releases/latest';
    }

    private appendLog(line: string): void {
        const trimmed = String(line).trim();
        if (!trimmed) return;
        this.status.log.push(trimmed);
        if (this.status.log.length > LOG_MAX) {
            this.status.log = this.status.log.slice(-LOG_MAX);
        }
        this.emit('log', trimmed);
        this.emit('status', this.status);
    }

    private setStatus(patch: Partial<AutoUpdaterStatus>): void {
        this.status = { ...this.status, ...patch };
        this.emit('status', this.status);
    }
}

let instance: AutoUpdater | null = null;
export function autoUpdaterInstance(): AutoUpdater {
    if (!instance) instance = new AutoUpdater();
    return instance;
}

function pickReleaseUrl(info: UpdateInfo): string | null {
    const tag = info.version ? `v${info.version}` : null;
    if (!tag) return null;
    return `https://github.com/Renaissance-Analytics/genie/releases/tag/${tag}`;
}

/**
 * Decide which updater path to expose to the renderer.
 *   - Packaged production builds: Phase 2 (electron-updater).
 *   - Dev / git-clone installs: Phase 1 (git-pull-and-rebuild).
 */
export function updaterMode(): 'phase2' | 'phase1' {
    return app.isPackaged ? 'phase2' : 'phase1';
}
