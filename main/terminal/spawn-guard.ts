/**
 * A ceiling on how often one process spec may be (re)spawned.
 *
 * ## Why this exists rather than another fix to the backoff
 *
 * Three "Moic" worker processes respawned every five or six seconds,
 * continuously, for FIVE DAYS — 9,306 starts, still going when it was found. In
 * the twenty minutes before the shared pty host died of an access violation
 * (`0xC0000005`, 22 terminals live, every one of them lost) there were 684 spawn
 * requests, 678 of them those three workers. Constant pty create/teardown is
 * exactly the load that faults ConPTY, so the loop was not merely noisy: it was
 * the thing taking the machine down.
 *
 * The backoff policy in `process-lifecycle.ts` is CORRECT — 1s, 2s, 4s, 8s, 16s,
 * then `failed`. The observed period was a flat five seconds, which is not any
 * point on that curve, so at least one restart path was not going through it
 * (`onProcessPtyExit`'s `restartRequested` branch respawns immediately, with no
 * backoff and no attempt increment, and it is not the only caller of
 * `startProcess`).
 *
 * This deliberately does not try to prove every path correct. It sits at the ONE
 * place a process pty is created, so any path — a deliberate restart, an
 * autostart, a reconcile, a GApp re-assert, or one nobody has thought of yet —
 * passes through it. A guard every route must cross is worth more than five
 * routes argued to be right.
 *
 * ## What it is not
 *
 * It is not a replacement for backoff, and it is not tuned to catch a service
 * that legitimately restarts now and then. The ceiling is far above any healthy
 * pattern: ten starts in a minute is already six times faster than the fastest
 * step of the exponential curve. Anything hitting it is looping.
 */

/** The window over which starts are counted. */
export const SPAWN_WINDOW_MS = 60_000;
/**
 * Starts allowed per window before a spec is refused.
 *
 * Generous on purpose. A process on the real backoff curve manages at most five
 * in a minute and then stops by itself; a crashlooping one managed twelve. The
 * gap between those is where this sits, so it never fires on healthy behaviour.
 */
export const SPAWN_LIMIT = 10;

export interface SpawnVerdict {
    /** Refuse this spawn — the spec is looping. */
    refuse: boolean;
    /** How many starts are inside the window, including the one being asked about. */
    recent: number;
}

/**
 * Per-spec spawn history. One instance backs the supervisor; tests construct
 * their own with a fake clock.
 */
export class SpawnGuard {
    private readonly starts = new Map<string, number[]>();
    private readonly now: () => number;
    private readonly windowMs: number;
    private readonly limit: number;

    constructor(
        now: () => number = Date.now,
        windowMs: number = SPAWN_WINDOW_MS,
        limit: number = SPAWN_LIMIT,
    ) {
        this.now = now;
        this.windowMs = windowMs;
        this.limit = limit;
    }

    /**
     * Ask whether this spec may start, RECORDING the attempt either way.
     *
     * Refusals are counted too. A caller that ignores the verdict and keeps
     * asking must not be able to age its own history out of the window by
     * hammering — the record is of attempts, not of successes.
     */
    check(id: string): SpawnVerdict {
        const t = this.now();
        const kept = (this.starts.get(id) ?? []).filter((at) => t - at < this.windowMs);
        kept.push(t);
        this.starts.set(id, kept);
        return { refuse: kept.length > this.limit, recent: kept.length };
    }

    /**
     * Forget a spec's history — for a DELIBERATE act by a person: starting it
     * from the UI, stopping it, restarting it.
     *
     * Someone who has just been told a process is looping, and who acts anyway,
     * is making a decision with the evidence in front of them. The guard exists
     * to stop an automatic loop, not to argue with a human.
     */
    clear(id: string): void {
        this.starts.delete(id);
    }

    /** Starts recorded for `id` inside the current window (diagnostics). */
    recent(id: string): number {
        const t = this.now();
        return (this.starts.get(id) ?? []).filter((at) => t - at < this.windowMs).length;
    }
}
