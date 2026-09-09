import { upgradeRestartPlan } from '../agents/drain';

/**
 * THE ONE DOOR TO A RESTART-TO-APPLY (genie#565).
 *
 * genie#389 built the drain — every live agent is asked to stop, write a
 * handoff and call `thumbsUp`, and the upgrade waits for the last row. It then
 * wired it to the `updater:restart` IPC and left a comment in that handler
 * saying *"Every door to `restartAndApply` passes through
 * `restartPlanForUpgrade`, so adding a door cannot skip the drain by
 * accident."*
 *
 * That was not true. Two other paths reached `restartAndApply` directly:
 *
 *  - the HANDS-FREE apply `downloadAndInstall()` arms, whose own comment reads
 *    *"One user click drives download → install → restart with no further
 *    prompts"* — the common path, and the one the owner was watching kill live
 *    agent terminals; and
 *  - `mobileInstallUpdate()`, the phone / remote install.
 *
 * The fix is not a fourth check. It is this: the decision, the drain
 * bookkeeping and the apply live together in one object, every door calls
 * `request`, and `restartAndApply` is reached from nowhere else. The comment
 * above is now a statement about the code rather than a hope about it.
 *
 * Everything the gate touches arrives as a dependency, so the whole thing —
 * including the property that a silent agent holds the upgrade FOREVER — is
 * exercised against the real {@link AgentDrain} with no Electron, no database
 * and no updater around it.
 */

export interface UpgradeRestartDeps {
    /**
     * How many agents the drain would nudge, or `null` when that cannot be
     * answered. Deliberately the DRAIN's own count rather than the terminal
     * interruption probe's: those two disagree, and when they do the gate wins
     * and agents die. See `currentRestartPlanInput` for which is which.
     */
    liveAgents: () => number | null;
    /** Has a drain already run to completion in this process? */
    drainCleared: () => boolean;
    /**
     * Nudge every agent and hold until the roster clears. Resolves
     * `complete: false` when the drain was CANCELLED — which must apply
     * nothing, since that is the entire difference between this and a timeout.
     */
    beginDrain: () => Promise<{ complete: boolean }>;
    /** Record that the agents answered. Unlocks the quit-time barrier skip. */
    markDrainCleared: () => void;
    /** Record that a person chose not to wait. NEVER the same fact as above. */
    markForced: () => void;
    /** Apply the update now — `restartAndApply` → `quitAndInstall`. */
    applyNow: () => void;
}

export interface UpgradeRestartResult {
    ok: boolean;
    error?: string;
    /** Nothing restarted: the agents are being asked, and the roster is up. */
    draining?: boolean;
}

export class UpgradeRestartGate {
    private drainInFlight = false;

    constructor(private readonly deps: UpgradeRestartDeps) {}

    /** Is a drain holding an upgrade right now? */
    isDraining(): boolean {
        return this.drainInFlight;
    }

    /**
     * Ask for the restart. Either it happens, or the agents are asked first.
     *
     * `force` is the user's explicit Force Restart, taken after being shown the
     * roster and which agent has stopped answering. It is the ONLY way past a
     * wedged agent, because the drain deliberately never resolves on a clock —
     * so the escape has to be a person, and it has to say so.
     */
    request(opts: { force?: boolean } = {}): UpgradeRestartResult {
        const force = opts.force === true;

        if (force) {
            // Recorded BEFORE the apply: `applyNow` quits the process, and a
            // flag written after it is a flag never written. The quit-time
            // readiness barrier reads this to avoid spending thirty seconds
            // re-asking agents the user has just declined to wait for.
            this.deps.markForced();
            // The drain is deliberately NOT cancelled. `cancelUpgradeDrain`
            // also clears the RESTORE ROSTER — the list of what to bring back
            // on the other side (genie#551) — and a forced restart still tears
            // those agents down, so that list is exactly what it needs. Left
            // running, it simply dies with the process.
            return this.apply();
        }

        // A second click while the roster is up must not re-nudge anyone: two
        // `begin` calls would put the drain's ask in every agent's box twice
        // and leave two rosters disagreeing about which upgrade is held.
        if (this.drainInFlight) return { ok: true, draining: true };

        const plan = upgradeRestartPlan({
            force: false,
            liveAgents: this.deps.liveAgents(),
            drainComplete: this.deps.drainCleared(),
        });
        if (plan === 'apply') return this.apply();

        return this.startDrain();
    }

    private startDrain(): UpgradeRestartResult {
        this.drainInFlight = true;
        let done: Promise<{ complete: boolean }>;
        try {
            done = this.deps.beginDrain();
        } catch (e) {
            // A drain that cannot even start must not apply the update behind
            // the user's back — and must not reject the caller either, since
            // the renderer has no handler for that and would leave the control
            // mid-click. Say what happened and stay clickable.
            this.drainInFlight = false;
            return {
                ok: false,
                error: `The agent drain could not start: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            };
        }
        void done
            .then((snapshot) => {
                this.drainInFlight = false;
                // A CANCELLED drain reports incomplete, and applies nothing.
                if (!snapshot.complete) return;
                this.deps.markDrainCleared();
                try {
                    this.deps.applyNow();
                } catch {
                    /* surfaced on the status stream, as every apply failure is */
                }
            })
            .catch(() => {
                this.drainInFlight = false;
            });
        return { ok: true, draining: true };
    }

    private apply(): UpgradeRestartResult {
        try {
            this.deps.applyNow();
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
}
