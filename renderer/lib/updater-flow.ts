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

/** What the UpdatePill's post-commit driver should do on this status tick. */
export type CommitStep = 'apply' | 'restart' | 'reset' | 'none';

/**
 * One tick of the pill's post-commit state machine. The one-shot refs make each
 * step fire at most once per commit — but a commit whose update DIES (the
 * download errors, or a re-check concludes we're already current) must hand the
 * pill BACK: without 'reset', those refs stayed armed forever and the next
 * 'available' rendered a committed pill with no button and no driver — wedged
 * on "Upgrading…" until Genie restarted.
 */
export function planCommitStep(opts: {
    state: string;
    committed: boolean;
    /** appliedRef — updater.apply() already fired this commit. */
    applied: boolean;
    /** restartedRef — the restart step already fired this commit. */
    restarted: boolean;
    /** Set when auto-apply can't run on this build (manual download only). */
    manualDownloadUrl: string | null;
    /**
     * True when a restart would interrupt live work (the backend HELD the
     * hands-free apply). We must NOT auto-drive the restart then — the pill
     * shows an explicit "Restart & update" confirm and the user decides when.
     */
    interruptionPending?: boolean;
}): CommitStep {
    if (!opts.committed) return 'none';
    // The update this commit was riding is gone — failed ('error') or moot
    // ('up-to-date'). Disarm so a future 'available' starts a fresh cycle.
    if (opts.state === 'error' || opts.state === 'up-to-date') return 'reset';
    if (opts.state === 'available' && !opts.manualDownloadUrl && !opts.applied) {
        return 'apply';
    }
    // A held restart (live work would be interrupted) is user-confirmed, never
    // auto-driven — the pill renders the confirm button and calls restart itself.
    if (opts.state === 'ready-to-restart' && !opts.restarted && !opts.interruptionPending) {
        return 'restart';
    }
    return 'none';
}
