/**
 * "Reopen the master window after an update apply."
 *
 * Genie launches to the tray and, by default, opens the master window too. Two
 * things suppress that open: the user's explicit `start_minimized` preference,
 * and an autostart (OS sign-in) launch — a login-launched Genie must not ambush
 * the user with a window on every boot.
 *
 * An AUTO-UPDATE relaunch is neither. The user was actively using Genie, saw the
 * update and clicked it; the updater then quit-and-relaunched. On Windows that
 * relaunch can look like an autostart launch to {@link launchedFromAutostart},
 * so the window silently stayed in the tray after every upgrade — the regression
 * this module fixes.
 *
 * We record the intent EXPLICITLY rather than inferring it from launch args:
 * `restartAndApply` persists a one-shot flag before `quitAndInstall`, and boot
 * consumes it. The pure decision below is unit-tested; the persistence lives in
 * the settings KV (`db.ts`), read/cleared once at boot.
 */

/** Settings KV key: set at update-apply, consumed once on the next boot. */
export const REOPEN_AFTER_UPDATE_KEY = 'reopen_after_update';

export interface BootWindowInput {
    /** An E2E harness owns its own window — never auto-open here. */
    isE2E: boolean;
    /** The OS launched Genie at sign-in (autostart) — normally tray-only. */
    fromAutostart: boolean;
    /** The user's explicit "start minimized to tray" preference. */
    startMinimized: boolean;
    /** The last quit was an update apply, so the window should reopen. */
    reopenAfterUpdate: boolean;
}

/**
 * Whether boot should open the master window.
 *
 * The `start_minimized` preference is ALWAYS honoured — the user asked for
 * tray-only, and an update must not override a deliberate choice. The autostart
 * suppression, by contrast, is an inference about how the OS launched us, and an
 * update relaunch is not a sign-in — so `reopenAfterUpdate` overrides it.
 */
export function shouldShowMasterWindowOnBoot(i: BootWindowInput): boolean {
    if (i.isE2E) return false;
    if (i.startMinimized) return false;
    return i.reopenAfterUpdate || !i.fromAutostart;
}
