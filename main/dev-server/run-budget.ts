import type { RunOptions } from './container-runtime';

/**
 * PURE. How long a command that INSTALLS something may take, and what to say
 * when Genie stops waiting for it.
 *
 * ## The bug
 *
 * The setup wizard ran `winget install --id Git.Git …` through
 * `toolchain-effects`, which called the plain runner with no options at all — so
 * the install silently inherited `seams.ts`'s `DEFAULT_TIMEOUT_MS`, a budget
 * sized for `docker ps`. Git is FIRST in `INSTALL_ORDER` and, in a normal run,
 * the only winget call there is (node/php go through Genie's own engine
 * installer, composer and the VC++ runtime are direct downloads, the agent TUIs
 * are `npm i -g`), so it alone pays winget's first-use cost — accepting the
 * source agreements and refreshing the sources — before a ~70 MB download even
 * begins. Two minutes was never going to be enough, and the six tools after it
 * all succeeded, which is what made the failure look Git-specific rather than
 * budget-specific.
 *
 * ## Why the budget is a FLOOR and not a wall
 *
 * A wall-clock cap on a package install is guessing: the right number depends on
 * the package, the machine and the link, and Genie knows none of them. Raising
 * the guess only moves the boundary. So a command gets {@link INSTALL_BUDGET_MS}
 * to begin with — the same figure the elevated path and the artifact installers
 * already used, so nothing here can expire SOONER than before — and if it is
 * still producing output when that expires it is demonstrably not hung, and gets
 * more time. {@link INSTALL_CEILING_MS} bounds that, so a process that chatters
 * forever without finishing still ends.
 *
 * Output is the honest liveness signal for exactly the reason the envelope's own
 * protocol notes give for agent transcripts: elapsed time says nothing about
 * whether work is happening, and activity does.
 */

/**
 * The floor: how long an install may take before silence starts to look like a
 * hang. 15 minutes — deliberately the number `toolchain-primitives`'
 * `runElevated` and `toolchain-manager`'s installer/extract calls already
 * carried, so consolidating on it changes no path for the worse.
 */
export const INSTALL_BUDGET_MS = 15 * 60_000;

/**
 * How much longer a command that just produced output gets. Sized as "nothing at
 * all has happened for this long", not "this is taking a while": winget renders
 * its download progress to a console and says very little down a pipe, so a
 * short grace here would kill a healthy slow download — the very failure this
 * module exists to stop.
 */
export const INSTALL_IDLE_GRACE_MS = 5 * 60_000;

/** The wall extension can never pass. A half hour of a process that talks but
 *  never finishes is wedged, whatever it is printing. */
export const INSTALL_CEILING_MS = 30 * 60_000;

/**
 * What to add to a timeout message for an INSTALL, as opposed to a probe.
 *
 * It must not say the install was cancelled, because it was not.
 * `child.kill()` reaches the DIRECT child and no further: a host-tool install on
 * Windows is spawned through `cmd.exe` (the `.cmd`-shim rule in `seams.ts`), so
 * the kill lands on the shell while winget — and the Git installer winget
 * launched — carry on to completion. The elevated path has the same shape, with
 * PowerShell in the shell's place. Telling someone their install failed and
 * inviting them to start another one, while the first is still writing to
 * Program Files, is how a clean "still working" becomes a real collision.
 */
export const INSTALL_TIMEOUT_NOTE =
    'Genie stopped waiting; it did not stop the installer, which may still be ' +
    'finishing in the background. Give it a few minutes, then re-run setup to ' +
    'check before installing the same tool again.';

/** The options every install call passes, so there is one definition of "how
 *  long an install may take" rather than a constant per call site. */
export const INSTALL_RUN_OPTIONS: RunOptions = {
    timeoutMs: INSTALL_BUDGET_MS,
    idleGraceMs: INSTALL_IDLE_GRACE_MS,
    ceilingMs: INSTALL_CEILING_MS,
    timeoutNote: INSTALL_TIMEOUT_NOTE,
};

/**
 * The deadline after a chunk of output arrived at `now`.
 *
 * Two guards, and both are the whole point:
 *   - it never SHORTENS — a chunk one second in must not replace the floor with
 *     `now + grace`, or a chatty install would fail sooner than a silent one,
 *     and neither may a ceiling that a caller set below the budget it asked
 *     for. The ceiling bounds EXTENSION; it is not permission to cut the floor.
 *   - it never extends past `startedAt + ceilingMs`.
 */
export function extendedDeadline(opts: {
    startedAt: number;
    now: number;
    deadline: number;
    idleGraceMs: number;
    ceilingMs: number;
}): number {
    const extended = Math.min(opts.startedAt + opts.ceilingMs, opts.now + opts.idleGraceMs);
    return Math.max(opts.deadline, extended);
}

/**
 * The message for a command Genie stopped waiting for.
 *
 * Kept short enough that `toolchain-perform`'s 400-character tail shows all of
 * it: that tail is what a wizard row renders, and a longer message is truncated
 * from the FRONT, which would drop the command name first.
 */
export function formatRunTimeout(command: string, waitedMs: number, note?: string): string {
    const base = `${command} timed out after ${humanDuration(waitedMs)}.`;
    return note ? `${base} ${note}` : base;
}

/** "120000ms" is what the reporter saw, and it told them nothing. */
function humanDuration(ms: number): string {
    if (ms < 60_000) {
        const seconds = Math.max(1, Math.round(ms / 1_000));
        return `${seconds} second${seconds === 1 ? '' : 's'}`;
    }
    const minutes = Math.round(ms / 60_000);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
