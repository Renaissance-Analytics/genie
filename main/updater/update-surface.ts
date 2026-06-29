import { isNewer } from './git-updater';

/**
 * Pure decision helpers for the Linux-update-surfacing fix — kept out of the
 * stateful updater so they're unit-testable without electron / a real AppImage.
 *
 * Two Linux branches the auto-updater can't otherwise handle:
 *   1. `process.env.APPIMAGE` is UNSET → electron-updater's AppImageUpdater is
 *      inert (`isUpdaterActive()` is false), so `checkForUpdates()` no-ops and
 *      the user is never told. We DETECT that and fall back to a direct GitHub
 *      version check + a MANUAL-download surface.
 *   2. An update IS detected but, tray-resident with no window, only the native
 *      Notification + tray badge surface it (both flakier on Linux). We make the
 *      notification reliable (click-to-act) and keep the state for the next
 *      window open.
 */

/**
 * True for a Linux AppImage build whose updater is INERT because `APPIMAGE`
 * isn't set in the environment — when this holds, electron-updater's
 * `checkForUpdates()` silently returns nothing, so we use the manual-download
 * fallback instead of reporting a false "up to date".
 */
export function appImageUpdateUnavailable(env: {
    platform: NodeJS.Platform | string;
    isPackaged: boolean;
    appimage: string | undefined;
}): boolean {
    return env.platform === 'linux' && env.isPackaged && !env.appimage;
}

export interface ManualDownloadPlan {
    /** A newer version exists and the user should download it by hand. */
    available: boolean;
    /** The latest version found (null when the check turned nothing up). */
    version: string | null;
    /** The release URL to download (null unless available). */
    url: string | null;
}

/**
 * Decide whether a manually-fetched `latest` version is newer than `current`
 * and where to download it. Pure (`releaseUrl` builds the link). Used by the
 * APPIMAGE-unset fallback.
 */
export function planManualDownload(
    latest: string | null,
    current: string,
    releaseUrl: (version: string) => string,
): ManualDownloadPlan {
    if (latest && isNewer(latest, current)) {
        return { available: true, version: latest, url: releaseUrl(latest) };
    }
    return { available: false, version: latest, url: null };
}

export interface UpdateNotice {
    /** Whether to fire a native notification this status tick. */
    fire: boolean;
    title: string;
    body: string;
    /** 'download' → open the manual URL; 'open' → surface the in-app pill. */
    action: 'download' | 'open';
    url: string | null;
}

/**
 * Decide the native "update available" notification for a status tick. Fires
 * ONCE per discovered version (dedup against `notifiedVersion`) and only when
 * notifications are supported. A MANUAL-download update routes the click to the
 * download URL; an ordinary auto-update routes it to the window (where the
 * Upgrade pill lives). Pure.
 */
export function planUpdateNotification(
    status: { state: string; latestVersion: string | null; manualDownloadUrl?: string | null },
    deps: { supported: boolean; notifiedVersion: string | null },
): UpdateNotice {
    const v = status.latestVersion;
    const fire =
        status.state === 'available' && !!v && v !== deps.notifiedVersion && deps.supported;
    const title = `Genie ${v ? `v${v} ` : ''}is available`;
    if (status.manualDownloadUrl) {
        return {
            fire,
            title,
            body: 'Auto-update is unavailable on this build — click to download the new version.',
            action: 'download',
            url: status.manualDownloadUrl,
        };
    }
    return {
        fire,
        title,
        body: 'Click to open Genie and install the update.',
        action: 'open',
        url: null,
    };
}
