/**
 * THE RESTORE HALF OF THE DRAIN (genie#389).
 *
 * A drain that stops everything and leaves it stopped just moves the work onto
 * the user, so the roster the drain built is also the restore list: every agent,
 * site and background process that was RUNNING when the drain began comes back
 * after the upgrade. Not offered — restarted.
 *
 * Two rules govern it, and they pull in opposite directions.
 *
 * ## Genie may restore what IT stopped; it must never restart what the USER
 * stopped
 *
 * genie#407's rule, and genie#412's storage. A site's desired RUN state is
 * machine-local (`site_run_state`); a process's pause is `meta.user_stopped`.
 * The restore READS both. Restoring on any broader rule — "start everything in
 * the roster", or worse "start everything configured" — resurrects exactly what
 * the user deliberately switched off, at the moment they are least able to tell
 * the difference between Genie's doing and their own.
 *
 * The two stores are consulted SEPARATELY rather than through one predicate: a
 * site id and a process spec id are different namespaces, and one shared lookup
 * is how a paused process would silently suppress a site that happens to share
 * its name.
 *
 * There is no user-stopped AGENT. An agent the user satisfied by hand in the
 * drain's stuck path is still an agent that was running, and is still restarted
 * — the whole point of the manual satisfy is to let the upgrade proceed, not to
 * decide the agent should stay dead.
 *
 * ## The stagger is a requirement, not a nicety
 *
 * Restarting every agent TUI, every hosted site and every background process in
 * one tick is a thundering herd on a machine that has just finished an upgrade.
 * Each agent TUI is a full harness process; sites bind ports, and simultaneous
 * starts are precisely the condition that produces port races and the "reported
 * ready, answered nothing" class of bug; toolchain-backed processes contend on
 * the same node/php binaries and caches. {@link DRAIN_RESTORE_GAP_MS} is the
 * floor the issue sets, and it is between STARTS — an entry that is skipped
 * costs nothing, because nothing was started to contend with.
 */

/**
 * The floor between two starts. 3 seconds, per genie#389, applied to agents,
 * sites and processes alike rather than inventing a second number for one of
 * them.
 */
export const DRAIN_RESTORE_GAP_MS = 3_000;

export type DrainRestoreKind = 'agent' | 'site' | 'process';

/** One thing that was running when the drain began. */
export interface DrainRestoreEntry {
    kind: DrainRestoreKind;
    /** The agent id / site id / process spec id — whatever starts it again. */
    ref: string;
    /** What the roster calls it. */
    label: string;
    workspaceId: string;
}

/**
 * PURE. The restore list, built from what was RUNNING when the drain began.
 *
 * The `running` flags are what make this a snapshot rather than a policy. A
 * site that was down at drain time is not on the list, so the restore has no
 * way to start it — which is the structural half of *"nothing started that was
 * not running before"*. The desired-state filter in {@link planDrainRestore} is
 * the other half, and covers a stop made BETWEEN the drain and the restore.
 *
 * Agents first, then sites, then processes. A person watching the roster is
 * watching the agents, so they come back first; sites before processes because
 * a background process is very often the thing a site's dev server is waiting
 * on rather than the reverse.
 */
export function drainRosterFrom(input: {
    agents: readonly { agentId: string; name: string; workspaceId: string }[];
    sites: readonly { siteId: string; label: string; workspaceId: string; running: boolean }[];
    processes: readonly { specId: string; label: string; workspaceId: string; running: boolean }[];
}): DrainRestoreEntry[] {
    return [
        ...input.agents.map((agent) => ({
            kind: 'agent' as const,
            ref: agent.agentId,
            label: agent.name,
            workspaceId: agent.workspaceId,
        })),
        ...input.sites
            .filter((site) => site.running)
            .map((site) => ({
                kind: 'site' as const,
                ref: site.siteId,
                label: site.label,
                workspaceId: site.workspaceId,
            })),
        ...input.processes
            .filter((proc) => proc.running)
            .map((proc) => ({
                kind: 'process' as const,
                ref: proc.specId,
                label: proc.label,
                workspaceId: proc.workspaceId,
            })),
    ];
}

/** The durable desired state, as genie#412 records it. */
export interface DrainRestoreDesiredState {
    siteStoppedByUser: (siteId: string) => boolean;
    processStoppedByUser: (specId: string) => boolean;
    /**
     * Is this thing up ALREADY?
     *
     * The roster outlives a crash, and it is written before the upgrade rather
     * than after the drain clears — so a launch can legitimately find a restore
     * list for things that were never stopped (Genie died in between, or the
     * user cancelled the restart). `startProcess` on a live process is a
     * RESTART, so a blind restore would bounce exactly what it exists to
     * protect.
     *
     * Optional, and its ABSENCE means "nothing is running" rather than
     * "everything is" — the direction that restores rather than the one that
     * silently restores nothing.
     */
    alreadyRunning?: (entry: DrainRestoreEntry) => boolean;
}

export interface DrainRestoreDecision {
    entry: DrainRestoreEntry;
    start: boolean;
    /** Why not, in the words the roster shows. Set only when `start` is false. */
    reason?: string;
}

/**
 * PURE. What the restore may start, and what it must leave alone.
 *
 * Separate from the executor because every one of these refusals is a decision
 * that used to be made implicitly and wrongly, and asserting them needs a
 * function rather than a running app.
 */
export function planDrainRestore(
    roster: readonly DrainRestoreEntry[],
    desired: DrainRestoreDesiredState,
): DrainRestoreDecision[] {
    return roster.map((entry) => {
        if (desired.alreadyRunning?.(entry)) {
            return { entry, start: false, reason: 'It is already running.' };
        }
        if (entry.kind === 'site' && desired.siteStoppedByUser(entry.ref)) {
            return {
                entry,
                start: false,
                reason: 'You stopped it. An upgrade is not a reason to undo that.',
            };
        }
        if (entry.kind === 'process' && desired.processStoppedByUser(entry.ref)) {
            return {
                entry,
                start: false,
                reason: 'You paused it. An upgrade is not a reason to undo that.',
            };
        }
        return { entry, start: true };
    });
}

export interface DrainRestoreOutcome {
    entry: DrainRestoreEntry;
    status: 'started' | 'skipped' | 'failed';
    /** Why it was skipped, or what the start threw. */
    reason?: string;
    at: number;
}

export interface DrainRestoreInput {
    roster: readonly DrainRestoreEntry[];
    desired: DrainRestoreDesiredState;
    /** Start one entry. May throw or reject — the queue survives either. */
    start: (entry: DrainRestoreEntry) => void | Promise<void>;
    /** The gap's clock, injected so the suite does not sit through it. */
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
    gapMs?: number;
    /** Reported as each lands, so the roster shows the restore live — and shows
     *  a failure on the same row that showed the drain. */
    onOutcome?: (outcome: DrainRestoreOutcome) => void;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') timer.unref();
    });

/**
 * Run the restore, serialised with a gap between starts.
 *
 * A start that fails does NOT abort the rest of the queue: this runs once,
 * after an upgrade, and gets no second chance — a site that will not come back
 * must not take the other eleven with it. The failure is reported on the same
 * roster instead, which is where somebody is already looking.
 */
export async function runDrainRestore(input: DrainRestoreInput): Promise<DrainRestoreOutcome[]> {
    const now = input.now ?? Date.now;
    const wait = input.wait ?? sleep;
    const gapMs = input.gapMs ?? DRAIN_RESTORE_GAP_MS;
    const outcomes: DrainRestoreOutcome[] = [];
    let startedOne = false;

    for (const decision of planDrainRestore(input.roster, input.desired)) {
        if (!decision.start) {
            const outcome: DrainRestoreOutcome = {
                entry: decision.entry,
                status: 'skipped',
                ...(decision.reason ? { reason: decision.reason } : {}),
                at: now(),
            };
            outcomes.push(outcome);
            input.onOutcome?.(outcome);
            continue;
        }
        // BETWEEN starts, never in front of the first: a lone agent must not
        // wait three seconds for a herd of one.
        if (startedOne) await wait(gapMs);
        startedOne = true;
        let outcome: DrainRestoreOutcome;
        try {
            await input.start(decision.entry);
            outcome = { entry: decision.entry, status: 'started', at: now() };
        } catch (e) {
            outcome = {
                entry: decision.entry,
                status: 'failed',
                reason: e instanceof Error ? e.message : String(e),
                at: now(),
            };
        }
        outcomes.push(outcome);
        input.onOutcome?.(outcome);
    }
    return outcomes;
}
