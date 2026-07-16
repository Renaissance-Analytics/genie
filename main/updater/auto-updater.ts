import { app, net } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { EventEmitter } from 'node:events';
import { markQuittingForUpdate } from './quit-state';
import { isNewer } from './git-updater';
import { appImageUpdateUnavailable, planManualDownload } from './update-surface';

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
    /**
     * Set at 'ready-to-restart' ONLY when applying the update would INTERRUPT live
     * work — restarting Genie (and the pty-host it pins) tears down running
     * terminals / agent chats. When present, the hands-free auto-apply is HELD:
     * the update stays staged and the UI asks the user to confirm the restart (or
     * defer), so an upgrade never silently kills a live agent session. Null when
     * nothing live would be interrupted (idle, or a service-host that survives the
     * swap) — then the apply runs hands-free as before.
     */
    interruption: RestartInterruption | null;
}

/**
 * What a restart-to-apply would tear down. Counts are of LIVE work at the moment
 * the build finished downloading. `agentChats` is the subset of `terminals` that
 * are running an AI agent (the data-loss-sensitive ones we lead the warning with).
 */
export interface RestartInterruption {
    terminals: number;
    agentChats: number;
}

/**
 * Pure gate for an ARMED (installWhenReady) update-downloaded: apply hands-free
 * only when nothing live would be interrupted; otherwise HOLD the staged build so
 * the user is warned and can defer. Exported so the decision is unit-testable
 * without electron-updater. Stack-safe by construction: it runs on EVERY
 * download-complete, so whichever build lands (even one that superseded an earlier
 * staged one) is gated the same way.
 */
export function decideDownloadedApply(
    interruption: RestartInterruption | null,
): 'apply' | 'hold' {
    return interruption && interruption.terminals > 0 ? 'hold' : 'apply';
}

const LOG_MAX = 2000;

class AutoUpdater extends EventEmitter {
    private status: AutoUpdaterStatus;
    private timer: NodeJS.Timeout | null = null;
    /**
     * Set the instant the user clicks "Update" (downloadAndInstall): tells the
     * `update-downloaded` handler to apply the build hands-free the moment it
     * lands — download → install → restart from that ONE click, with no second
     * confirmation. We NEVER download on our own: a check only ever surfaces an
     * update as 'available', and the download is always user-initiated. (This
     * flag's download AND electron-updater's own `autoDownload` both stay off
     * until that click — see bind().)
     */
    private installWhenReady = false;
    /**
     * The check currently running, if any. downloadAndInstall() awaits it
     * instead of refusing: the Upgrade click routinely races the window-show /
     * poll re-check (state 'checking'), and refusing there wedged the pill.
     */
    private inflightCheck: Promise<void> | null = null;
    /**
     * Injected probe (set by the updater IPC layer, which can reach the terminal
     * domain) that reports what a restart-to-apply would tear down RIGHT NOW. Kept
     * as an injection so this module stays decoupled from the pty-host. Null → the
     * gate sees no interruption and applies hands-free (the pre-existing behaviour).
     */
    private interruptionProbe: (() => RestartInterruption) | null = null;

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
            interruption: null,
        };
        this.bind();
    }

    /**
     * Wire the "what would a restart interrupt?" probe. Called once at IPC setup.
     * Without it the gate can't see live terminals and falls back to hands-free
     * apply — so this MUST be set for the warn-before-restart behaviour to engage.
     */
    setInterruptionProbe(fn: () => RestartInterruption): void {
        this.interruptionProbe = fn;
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
        // Only an ACTIVELY-busy state blocks a re-check: a check already in
        // flight, or an installer mid-download. Re-entering either would fight
        // the operation already running (a second concurrent download would race
        // the first). A build that's merely STAGED ('ready-to-restart') is NOT
        // busy — we deliberately re-check OVER it so a newer release can be found
        // and supersede it. (Bailing on 'ready-to-restart' was the bug: once
        // beta.58 was staged, every later check — manual button included — went
        // dead, so beta.59 was never picked up.)
        if (
            this.status.state === 'checking' ||
            this.status.state === 'downloading'
        ) {
            return;
        }
        const run = this.runCheck();
        this.inflightCheck = run;
        try {
            await run;
        } finally {
            if (this.inflightCheck === run) this.inflightCheck = null;
        }
    }

    private async runCheck(): Promise<void> {
        // What (if anything) is already downloaded and waiting to apply. Lets us
        // tell "the staged build is still the latest" (keep it) apart from "a
        // newer build now exists" (supersede it).
        const stagedVersion =
            this.status.state === 'ready-to-restart'
                ? this.status.latestVersion
                : null;

        this.setStatus({ state: 'checking', error: null, manualDownloadUrl: null, interruption: null });

        // Linux AppImage updater is INERT when APPIMAGE is unset — electron-
        // updater's checkForUpdates() then no-ops and would falsely report "up to
        // date". Detect it and check GitHub directly, surfacing a MANUAL download.
        if (this.appImageUnavailable()) {
            await this.checkViaManualDownload(stagedVersion);
            return;
        }

        try {
            const res = await autoUpdater.checkForUpdates();
            if (!res || !res.updateInfo) {
                // No release metadata — don't drop a good staged build back to a
                // bare "up to date"; keep it ready to apply.
                this.setStatus(
                    stagedVersion
                        ? { state: 'ready-to-restart', latestVersion: stagedVersion, progress: 1 }
                        : { state: 'up-to-date' },
                );
                return;
            }
            const latest = res.updateInfo.version;
            if (latest === app.getVersion()) {
                this.setStatus({ state: 'up-to-date', latestVersion: latest });
            } else if (stagedVersion && latest === stagedVersion) {
                // The build we already downloaded IS still the latest — return to
                // the ready-to-restart resting state without re-downloading it.
                this.setStatus({
                    state: 'ready-to-restart',
                    latestVersion: latest,
                    progress: 1,
                });
            } else {
                // A version newer than the running app (and than anything already
                // staged): surface it as 'available'. We do NOT download here —
                // "auto-update" means hands-FREE once the user clicks "Update",
                // not download-behind-their-back. The Update button drives
                // downloadAndInstall(); because this check has just refreshed
                // electron-updater's view to `latest`, that download fetches the
                // newest build, never a stale staged one.
                this.setStatus({
                    state: 'available',
                    latestVersion: latest,
                    publishedAt: res.updateInfo.releaseDate ?? null,
                    releaseUrl: pickReleaseUrl(res.updateInfo),
                });
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // A flaky/offline re-check must not throw away a build we'd already
            // downloaded and staged — restore it so the user can still apply it.
            // The failure is still captured in the log stream.
            if (stagedVersion) {
                this.appendLog(`check failed: ${msg}`);
                this.setStatus({
                    state: 'ready-to-restart',
                    latestVersion: stagedVersion,
                    progress: 1,
                });
                return;
            }
            // A release that's mid-publish (its `latest.yml` isn't at the public
            // download URL yet — GitHub un-drafts the release and propagates its
            // assets to the CDN a few seconds apart, so a check in that ~6-min
            // window 404s on latest.yml) is NOT a real error. Don't dump a scary
            // HTTP 404 at the user — treat it as up-to-date; the next check finds
            // the release once its manifest is live.
            if (isReleasePublishingError(msg)) {
                this.appendLog(`update manifest not published yet — treating as up-to-date: ${msg}`);
                this.setStatus({ state: 'up-to-date' });
                return;
            }
            this.setStatus({
                state: 'error',
                error: msg,
                manualDownloadUrl: this.manualUrlForPlatform(),
            });
        }
    }

    /**
     * The one-click "Update" action: download the available build and, the
     * instant it lands, apply it hands-free (the `update-downloaded` handler
     * sees `installWhenReady` and runs restartAndApply → quitAndInstall). One
     * user click drives download → install → restart with no further prompts.
     *
     * Because checkForUpdate() always refreshes electron-updater's view to the
     * LATEST release before we ever reach 'available', the build downloaded here
     * is always the newest one — never a stale previously-staged version.
     */
    async downloadAndInstall(): Promise<void> {
        // The Upgrade click can land while a background re-check is in flight
        // (window-show / poll both call checkForUpdate). The update the user
        // clicked is still real — wait for the check to settle rather than
        // refusing, then proceed off its fresh verdict.
        if (this.status.state === 'checking' && this.inflightCheck) {
            await this.inflightCheck.catch(() => {});
        }
        if (this.status.state !== 'available') {
            throw new Error('No update available to install.');
        }
        this.installWhenReady = true;
        this.setStatus({ state: 'downloading', progress: 0, error: null, interruption: null });
        try {
            await autoUpdater.downloadUpdate();
            // On success the `update-downloaded` handler in bind() flips us to
            // 'ready-to-restart' and — because installWhenReady is set — applies
            // immediately.
        } catch (e) {
            this.installWhenReady = false;
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
        //   isSilent=true — run the oneClick NSIS installer with NO UI (our
        //     installer is `oneClick: true`, `perMachine: false` → no wizard,
        //     no UAC), so the whole update applies hands-free off the single
        //     "Update" click that kicked the download.
        //   isForceRunAfter=true — relaunch Genie once the install completes.
        autoUpdater.quitAndInstall(true, true);
    }

    private bind(): void {
        // electron-updater's OWN auto-download stays OFF, and so does any
        // download of ours: a check only ever SURFACES an update ('available'),
        // it never downloads behind the user's back. The download is always
        // user-initiated via downloadAndInstall() (the "Update" button), which
        // carries our log/progress/error UX and then applies hands-free.
        // autoInstallOnAppQuit stays OFF too — we never want a silent install on
        // a normal quit; install happens ONLY through the explicit
        // downloadAndInstall → restartAndApply → quitAndInstall path.
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
            // What a restart would tear down right now. Runs on EVERY download-
            // complete, so the gate is stack-safe (a build that superseded an
            // earlier staged one is checked the same way).
            let interruption: RestartInterruption | null = null;
            try {
                const probed = this.interruptionProbe?.() ?? null;
                interruption = probed && probed.terminals > 0 ? probed : null;
            } catch {
                /* a broken probe must never wedge the update — treat as no interruption */
            }
            this.setStatus({
                state: 'ready-to-restart',
                latestVersion: info.version,
                progress: 1,
                interruption,
            });
            // Hands-free finish ONLY when nothing live would be interrupted. If a
            // restart would kill running terminals / agent chats, HOLD the staged
            // build: stay 'ready-to-restart' with the interruption surfaced and let
            // the UI ask the user to confirm the restart (or defer). An update must
            // never silently tear down a live agent session.
            if (this.installWhenReady && decideDownloadedApply(interruption) === 'apply') {
                this.installWhenReady = false;
                try {
                    this.restartAndApply();
                } catch (e) {
                    this.setStatus({
                        state: 'error',
                        error: e instanceof Error ? e.message : String(e),
                        manualDownloadUrl: this.manualUrlForPlatform(),
                    });
                }
            } else if (this.installWhenReady) {
                // Held for confirmation — disarm the auto-apply so the user's
                // explicit restartAndApply (via the pill) is what applies it.
                this.installWhenReady = false;
                this.appendLog(
                    `restart held — ${interruption?.agentChats ?? 0} agent chat(s) / ${interruption?.terminals ?? 0} terminal(s) live; awaiting user confirm`,
                );
            }
        });
        autoUpdater.on('error', (err) => {
            const msg = err?.message ?? String(err);
            // electron-updater surfaces a failed check BOTH as a rejected promise
            // (handled in checkForUpdate's catch) AND as this 'error' event. So a
            // release that's mid-publish — its `latest.yml` not yet at the public
            // download URL (the ~6-min un-draft/CDN window) — 404s here too. That
            // is NOT a real error; classify it and settle to up-to-date instead of
            // dumping a scary HTTP 404 at the user. The next check self-heals once
            // the manifest is live. (This was the missed path — beta.125 only
            // fixed the promise-catch.)
            if (isReleasePublishingError(msg)) {
                this.appendLog(`update manifest not published yet (error event) — treating as up-to-date: ${msg}`);
                this.setStatus({ state: 'up-to-date' });
                return;
            }
            // macOS Squirrel rejects an unsigned/ad-hoc build's signature on
            // apply ("code has no resources but signature indicates they must
            // be present") — there's no in-app recovery, so route the user to a
            // manual download instead of leaving them on a dead error.
            this.setStatus({
                state: 'error',
                error: msg,
                manualDownloadUrl: this.manualUrlForPlatform(),
            });
        });
    }

    /** True for a Linux AppImage build whose updater is inert (APPIMAGE unset). */
    private appImageUnavailable(): boolean {
        return appImageUpdateUnavailable({
            platform: process.platform,
            isPackaged: app.isPackaged,
            appimage: process.env.APPIMAGE,
        });
    }

    /**
     * The APPIMAGE-unset Linux fallback: electron-updater can't check OR apply, so
     * ask GitHub directly for the latest version and, when newer, surface a
     * MANUAL download (the renderer shows a "Download" button → the release page,
     * never the auto Update flow that would fail here). Quiet otherwise — a
     * transient fetch failure stays "up to date" rather than nagging.
     */
    private async checkViaManualDownload(stagedVersion: string | null): Promise<void> {
        this.appendLog(
            'Linux AppImage updater inactive (APPIMAGE unset) — checking GitHub for a manual download.',
        );
        let latest: string | null = null;
        try {
            latest = await fetchLatestGenieVersion();
        } catch (e) {
            this.appendLog(`manual-download check failed: ${e instanceof Error ? e.message : String(e)}`);
            latest = null;
        }
        const plan = planManualDownload(latest, app.getVersion(), releaseTagUrl);
        if (plan.available) {
            this.setStatus({
                state: 'available',
                latestVersion: plan.version,
                releaseUrl: plan.url,
                manualDownloadUrl: plan.url,
            });
            return;
        }
        this.setStatus(
            stagedVersion
                ? { state: 'ready-to-restart', latestVersion: stagedVersion, progress: 1 }
                : { state: 'up-to-date', latestVersion: latest ?? app.getVersion() },
        );
    }

    /**
     * The release to download by hand when auto-update can't apply on this
     * platform: macOS (Squirrel rejects the ad-hoc signature) and a Linux
     * AppImage launched without APPIMAGE (the updater is inert). Prefers the
     * exact tag once known, else the latest-release page. Null where auto-update
     * works.
     */
    private manualUrlForPlatform(): string | null {
        if (process.platform !== 'darwin' && !this.appImageUnavailable()) return null;
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
 * True when a check error is just "the release's update manifest isn't public
 * yet" rather than a real failure. A GitHub release un-drafts and its assets
 * propagate to the public `releases/download/<tag>/latest*.yml` URL a few seconds
 * apart, so a check landing in that window (or during the ~6-min publish build)
 * 404s on `latest.yml`. That's transient + self-healing — the next check finds
 * the release once its manifest is live — so we treat it as up-to-date instead of
 * dumping a scary HTTP 404 at the user.
 */
export function isReleasePublishingError(message: string): boolean {
    const m = message.toLowerCase();
    const isManifest = m.includes('.yml') || m.includes('cannot find');
    const isMissing = m.includes('404') || m.includes('not found') || m.includes('cannot find');
    return isManifest && isMissing;
}

/** The GitHub repo electron-updater publishes to (mirrors electron-builder.yml). */
const GENIE_REPO = 'Renaissance-Analytics/genie';

/** The download page for a specific version tag. */
function releaseTagUrl(version: string): string {
    return `https://github.com/${GENIE_REPO}/releases/tag/v${version}`;
}

/**
 * Fetch the newest Genie release version directly from GitHub — used ONLY by the
 * APPIMAGE-unset Linux fallback (electron-updater is inert there). Lists releases
 * (so PRE-releases, which Genie ships, are included — `/releases/latest` would
 * skip them), skips drafts, and returns the highest semver, or null. Never throws
 * past the caller's guard.
 */
async function fetchLatestGenieVersion(): Promise<string | null> {
    const res = await net.fetch(
        `https://api.github.com/repos/${GENIE_REPO}/releases?per_page=20`,
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Genie (updater)',
            },
        },
    );
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ tag_name?: string; draft?: boolean }>;
    if (!Array.isArray(list)) return null;
    let best: string | null = null;
    for (const r of list) {
        if (r?.draft) continue;
        const v = (r?.tag_name ?? '').replace(/^v/, '');
        if (!v) continue;
        if (!best || isNewer(v, best)) best = v;
    }
    return best;
}

/**
 * Decide which updater path to expose to the renderer.
 *   - Packaged production builds: Phase 2 (electron-updater).
 *   - Dev / git-clone installs: Phase 1 (git-pull-and-rebuild).
 */
export function updaterMode(): 'phase2' | 'phase1' {
    return app.isPackaged ? 'phase2' : 'phase1';
}
