/**
 * Pure lifecycle helpers for headless Process service runners (auto-restart
 * with backoff). The supervisor owns the ptys + timers; these functions decide
 * the status transitions so they stay unit-testable.
 */

export type ProcessStatus =
    | 'running'
    | 'stopped'
    | 'crashed'
    | 'restarting'
    | 'failed';

/** Max consecutive auto-restarts before a process is declared 'failed'. */
export const MAX_RESTART_ATTEMPTS = 5;

/** Exponential backoff (ms) before the Nth (0-based) consecutive restart, capped. */
export function restartDelay(attempt: number, baseMs = 1000, capMs = 30_000): number {
    return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
}

export interface ExitDecision {
    status: ProcessStatus;
    /** Schedule an auto-restart after this many ms (null = don't restart). */
    restartInMs: number | null;
    /** The attempt counter to carry forward. */
    nextAttempt: number;
}

/**
 * Decide what happens when a process's pty exits.
 *
 * @param userStopped     The exit was a deliberate stop/restart (not a crash).
 * @param restartOnExit   The spec opted into auto-restart.
 * @param exitCode        The process exit code (0 = clean).
 * @param attempt         Consecutive auto-restart attempts so far.
 */
export function decideOnExit({
    userStopped,
    restartOnExit,
    exitCode,
    attempt,
}: {
    userStopped: boolean;
    restartOnExit: boolean;
    exitCode: number;
    attempt: number;
}): ExitDecision {
    if (userStopped) {
        return { status: 'stopped', restartInMs: null, nextAttempt: 0 };
    }
    const crashed = exitCode !== 0;
    if (!restartOnExit) {
        return {
            status: crashed ? 'crashed' : 'stopped',
            restartInMs: null,
            nextAttempt: 0,
        };
    }
    if (attempt >= MAX_RESTART_ATTEMPTS) {
        return { status: 'failed', restartInMs: null, nextAttempt: attempt };
    }
    return {
        status: 'restarting',
        restartInMs: restartDelay(attempt),
        nextAttempt: attempt + 1,
    };
}

/**
 * Aggregate a workspace's per-process statuses into a single indicator for the
 * nav row icon: red if anything crashed/failed, green if anything is live,
 * yellow if processes exist but none are live, grey if there are none.
 */
export type WorkspaceProcStatus = 'none' | 'idle' | 'running' | 'crashed';

export function aggregateWorkspaceStatus(
    statuses: ProcessStatus[],
): WorkspaceProcStatus {
    if (statuses.length === 0) return 'none';
    if (statuses.some((s) => s === 'crashed' || s === 'failed')) return 'crashed';
    if (statuses.some((s) => s === 'running' || s === 'restarting')) return 'running';
    return 'idle';
}
