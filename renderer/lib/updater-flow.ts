/**
 * Whether the title-bar UpdatePill should drive the restart ITSELF
 * (api().updater.restart → restartAndApply → quitAndInstall) when an update
 * reaches `ready-to-restart`, or leave it to the backend.
 *
 * The phase-2 (electron-updater) backend finishes the job ONLY when WE kicked
 * the download this session: `downloadAndInstall()` sets `installWhenReady`, so
 * its own `update-downloaded` handler asks the restart GATE (genie#565), which
 * either applies or drains the agents first. On that path the frontend must NOT
 * also call `restart()`, or `quitAndInstall` fires TWICE — a double-install /
 * double-quit race on the common update path.
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
    /**
     * The drain this commit's restart started was CANCELLED (genie#565).
     *
     * The gate answers `draining: true` far more often than the old code did —
     * it consults the drain on every door, including paths where the
     * interruption probe reports nothing live. Nothing restarts; the roster
     * takes over. If the user then cancels, the upgrade is abandoned and the
     * commit riding it is over, so the pill must be handed back rather than
     * left armed with no driver.
     */
    drainCancelled?: boolean;
}): CommitStep {
    if (!opts.committed) return 'none';
    // The update this commit was riding is gone — failed ('error') or moot
    // ('up-to-date'), or the drain holding its restart was cancelled. Disarm so
    // a future 'available' starts a fresh cycle.
    if (opts.state === 'error' || opts.state === 'up-to-date') return 'reset';
    if (opts.drainCancelled === true) return 'reset';
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


/**
 * Is there an upgrade to look at — offered, downloading, applying, or staged?
 *
 * One list, read by three callers that must agree: the header label (what it
 * says), the pill (whether to fetch release notes) and the upgrade window
 * (whether the user may open it at all — genie#622, where the window is no
 * longer a projection of the drain and needs its own floor). Three private
 * copies of the same array is how they drift.
 */
const PENDING_STATES: ReadonlySet<string> = new Set([
    'available',
    'downloading',
    'applying',
    'ready-to-restart',
]);

export function updateIsPending(state: string | null | undefined): boolean {
    return PENDING_STATES.has(state ?? '');
}

/** What the Genie header label is showing right now. */
export type HeaderUpdateLabelKind =
    /** No update pending — the label states the version you are running. */
    | 'version'
    /** An update is on offer, and the label IS the button. */
    | 'upgrade'
    /** Auto-install can't run on this build; the label links to the release. */
    | 'download'
    /** Downloaded, but a restart would tear down live work — asks first. */
    | 'held'
    /** Committed and under way; no second click to mis-fire. */
    | 'progress';

export interface HeaderUpdateLabel {
    kind: HeaderUpdateLabelKind;
    text: string;
}

/**
 * THE GENIE LABEL, WHICH IS ALSO THE UPDATE CONTROL (genie#565).
 *
 * The wordmark used to read "Genie" and the update lived in a pill beside it —
 * plus a second full-width "Restart & update" banner underneath, which rendered
 * for the SAME `ready-to-restart` state and called the SAME `updater.restart()`.
 * Two buttons for one action, and a label that never said anything.
 *
 * Now there is one control and it is the label: what you are running when there
 * is nothing to do, and what you would be running if you clicked when there is.
 *
 * The wording lives here rather than in the component because the states are
 * the feature and there are more of them than a reader would guess — a build
 * this platform cannot auto-install, one held because agents are live, one
 * mid-download — and each has to say something true.
 */
export function headerUpdateLabel(opts: {
    state: string | null;
    /** The version running right now. */
    currentVersion: string;
    latestVersion: string | null;
    manualDownloadUrl: string | null;
    /** The user has clicked once; the flow is driving itself from here. */
    committed: boolean;
    progress: number | null;
    heldTerminals: number;
    heldChats: number;
    /**
     * The upgrade drain's roster, when one is holding the restart (genie#565).
     *
     * Since the hands-free apply started going through the gate,
     * `ready-to-restart` + committed no longer means "restarting" — it usually
     * means "holding, while every live agent finishes and writes a handoff".
     * The roster flyout names who; the label must not meanwhile narrate a
     * restart that is not happening.
     */
    draining?: { active: boolean; total: number; green: number } | null;
}): HeaderUpdateLabel {
    const pending = updateIsPending(opts.state);

    // Nothing on offer — including while a check is running, and including a
    // check that ERRORED. A failed poll is the updater's problem; the label's
    // job in that moment is still to say what is running.
    if (!pending) return { kind: 'version', text: `v${opts.currentVersion}` };

    const version = opts.latestVersion ? `v${opts.latestVersion}` : '';

    if (opts.manualDownloadUrl) {
        return { kind: 'download', text: version ? `Download ${version}` : 'Download' };
    }

    // HELD: the build is staged, but a restart would end live work. This
    // outranks `committed` — the backend disarmed its hands-free apply, so
    // rendering "Restarting…" would narrate a restart that is not happening.
    if (opts.state === 'ready-to-restart' && opts.heldTerminals > 0) {
        return {
            kind: 'held',
            text:
                opts.heldChats > 0
                    ? `Update · ${opts.heldChats} agent${opts.heldChats === 1 ? '' : 's'}`
                    : `Update · ${opts.heldTerminals} terminal${
                          opts.heldTerminals === 1 ? '' : 's'
                      }`,
        };
    }

    if (opts.state === 'downloading') {
        const pct =
            typeof opts.progress === 'number'
                ? ` ${Math.round(Math.max(0, Math.min(1, opts.progress)) * 100)}%`
                : '';
        return { kind: 'progress', text: `Downloading…${pct}` };
    }
    if (opts.state === 'applying') return { kind: 'progress', text: 'Installing…' };
    if (opts.state === 'ready-to-restart' && opts.committed) {
        // A drain is holding it: say what is actually being waited on. Once the
        // last row goes green the apply is on its way, so the count falls back
        // to the restart rather than sitting on "Waiting on 0 agents".
        const waiting = opts.draining?.active
            ? Math.max(0, opts.draining.total - opts.draining.green)
            : 0;
        if (waiting > 0) {
            return {
                kind: 'progress',
                text: `Waiting on ${waiting} agent${waiting === 1 ? '' : 's'}`,
            };
        }
        return { kind: 'progress', text: 'Restarting…' };
    }
    if (opts.committed) return { kind: 'progress', text: 'Upgrading…' };

    // The offer. A PRE-STAGED build (ready-to-restart, nothing live to
    // interrupt) is just as actionable as one not yet fetched — one click
    // commits either way. That state is what the deleted banner existed for.
    //
    // With no version named, "Upgrade to v" would trail off mid-sentence, so
    // the label drops the clause rather than showing half of it.
    return { kind: 'upgrade', text: version ? `Upgrade to ${version}` : 'Upgrade' };
}
