/**
 * Whether the title-bar UpdatePill should drive the restart ITSELF
 * (api().updater.restart → restartAndApply → quitAndInstall) when an update
 * reaches `ready-to-restart`, or leave it to the backend.
 *
 * The phase-2 (electron-updater) backend auto-restarts ONLY when WE kicked the
 * download this session: `downloadAndInstall()` sets `installWhenReady`, so its
 * own `update-downloaded` handler runs `restartAndApply()` → `quitAndInstall()`
 * hands-free. On that path the frontend must NOT also call `restart()`, or
 * `quitAndInstall` fires TWICE — a double-install / double-quit race on the
 * common update path.
 *
 * Every other path needs the frontend to drive the restart:
 *   - phase-2 PRE-STAGED build (the user committed while already
 *     `ready-to-restart`, so `apply()` never ran this session → installWhenReady
 *     was never set → the backend won't auto-restart); and
 *   - phase-1 git (`applyUpdate()` never auto-restarts; the frontend's
 *     `restart()` returns ok:false and falls back to `app.quit()`).
 */
export function shouldDriveRestart(opts: {
    mode: 'phase1' | 'phase2';
    /** True when the pill called updater.apply() (downloadAndInstall) this
     *  commit — i.e. the phase-2 backend's installWhenReady is armed. */
    appliedThisCommit: boolean;
}): boolean {
    const backendAutoRestarts = opts.mode === 'phase2' && opts.appliedThisCommit;
    return !backendAutoRestarts;
}
