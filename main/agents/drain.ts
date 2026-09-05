import { DEFAULT_AGENT_MODE, drainNudgeMode, type AgentMode } from './agent-mode';
import { NEVER_NUDGED_AGENT_NAME } from './reserved-names';

/**
 * DRAIN THE AGENTS BEFORE THE UPGRADE (genie#389).
 *
 * An upgrade kills every running agent mid-thought. The existing guard holds a
 * downloaded build when terminals are live and offers a "restart anyway", which
 * answers *"is anyone busy right now?"* — and nothing else. It never ASKS the
 * agents to finish, gives them no chance to write a handoff, and shows the user
 * neither who is holding things up nor a way to resolve one that has wedged. So
 * the user waits blind or forces, and forcing is what produced the disconnected
 * agents of genie#346 and the wrong upgrade notice of genie#371.
 *
 * The drain is the ask. Every live agent is nudged to stop, write its handoff
 * and call `thumbsUp`; a roster shows one row per agent, empty until that
 * agent's thumb lands; the upgrade waits for the last row.
 *
 * ## The manual satisfy is what makes it shippable
 *
 * A drain that can only end when every agent cooperates hangs forever on one
 * wedged TUI, which is worse than the kill it replaces. So a row that has not
 * answered inside {@link DRAIN_STUCK_AFTER_MS} says *stuck*, visibly different
 * from *waiting*, and the user can shut that agent down by hand and press its
 * thumb themselves. `satisfied` is stored distinctly from `ready` because they
 * are different facts: one is an agent's own answer, the other is a person
 * deciding on its behalf, and a roster that showed them identically would be
 * claiming an answer nobody gave.
 *
 * ## What this deliberately does NOT do
 *
 * It does not stop sites or background processes. Those go down with the app
 * and come back through {@link ./drain-restore}, which reads the durable
 * desired state genie#412 landed. The drain's job for them is only to RECORD
 * what was running, so the restore has a list.
 */

/**
 * How long an agent gets before its row reads *stuck*.
 *
 * Long enough for a real turn to end and a handoff to be written — an agent
 * mid-tool-call routinely goes minutes without touching its inbox — and short
 * enough that a person watching a roster is not left guessing. Nothing is lost
 * when it fires: `stuck` is a label on a row that is still waiting, not a
 * timeout that proceeds without the agent.
 */
export const DRAIN_STUCK_AFTER_MS = 3 * 60_000;

/** One agent the drain is waiting on. */
export interface DrainTarget {
    /**
     * `workspace_agents.id` — the id a `thumbsUp` acknowledges.
     *
     * Kept separate from {@link inboxAgentId} on purpose: the AgentInbox id is
     * minted per launch, so the two diverge the moment an agent is relaunched,
     * and a drain that used one for both waits on an agent it never nudged.
     */
    agentId: string;
    /** The AgentInbox id — what a `send` is addressed to. */
    inboxAgentId: string;
    terminalId: string;
    /** The agent's name, as the roster shows it. */
    name: string;
    workspaceId: string;
}

/**
 * How a row stands.
 *
 *  - `waiting`   — nudged, no answer yet. The empty icon.
 *  - `ready`     — the agent called `thumbsUp` itself. The green one.
 *  - `satisfied` — a person pressed the thumb for it (see the module note).
 *  - `stuck`     — nudged and silent past the deadline, or never reachable at
 *                  all. Still waiting; the difference is that the roster says
 *                  so and the user knows to act.
 *  - `gone`      — its terminal died mid-drain. Nothing is left to answer, so
 *                  nothing is waited on — and the agent is still restored,
 *                  because it was running when the drain began.
 */
export type DrainRowState = 'waiting' | 'ready' | 'satisfied' | 'stuck' | 'gone';

export interface DrainRow extends DrainTarget {
    state: DrainRowState;
    /** Who filled the row in. `null` for every state that is not green by an
     *  answer — including `gone`, which nobody answered. */
    satisfiedBy: 'agent' | 'user' | null;
    /** Why this row is stuck, in the words the roster shows. */
    note: string | null;
}

export interface DrainSnapshot {
    active: boolean;
    startedAt: number;
    rows: DrainRow[];
    /** Every row is green — the upgrade may proceed. */
    complete: boolean;
}

/** The three states that stop the drain waiting on a row. */
const GREEN: ReadonlySet<DrainRowState> = new Set<DrainRowState>(['ready', 'satisfied', 'gone']);

/** Whether a row still holds the drain up. Exported so the roster UI and the
 *  drain agree on one definition of "green" rather than each carrying a list. */
export function drainRowIsGreen(state: DrainRowState): boolean {
    return GREEN.has(state);
}

/**
 * What the drain asks for, in the order it needs it.
 *
 * STOP first, because an agent that reads "write a handoff" while still working
 * writes a handoff about work it then continues. HANDOFF second — it is the
 * whole reason the drain is worth more than the kill, and `boot-prompt.ts`
 * already tells the agent's next run to look for one. `thumbsUp` last, because
 * it is the signal that the two before it are done.
 */
export function drainNudgeText(mode: AgentMode): string {
    return [
        'Genie is upgrading, and this terminal will be closed to do it.',
        '',
        'Stop work now — do not start anything new, and do not begin a task you cannot finish ' +
            'in the next minute.',
        'Write your handoff: call `imDone` with a `handoff` note saying what you were in the ' +
            'middle of, what is unfinished, and what your next run should pick up. The next run ' +
            'of this agent is given that note on boot.',
        'Then call `thumbsUp` with reason "shutdown".',
        '',
        'Genie is holding the upgrade until every agent has answered, and restarts everything ' +
            'it stops — including you.',
        '',
        drainNudgeMode(mode),
    ].join('\n');
}

/**
 * PURE. The agents a drain may touch — everything except `general`.
 *
 * Tynn story #262's rule: *"No agents named general get any nudges or anything
 * so they don't start doing work on restart if any still exist."* Both halves
 * of the drain are covered by leaving them out here rather than at each of
 * them: a `general` agent that were nudged would be started doing work by the
 * nudge, and one on the restore list would be started doing work by the
 * restore. It also cannot be a drain ROW, because a row that may not be nudged
 * can never answer, and would be permanently stuck.
 *
 * Matches the WHOLE name, the same as {@link isReservedAgentName} — so
 * `general-purpose` is a real agent and is drained normally.
 */
export function drainableAgents(agents: readonly DrainTarget[]): DrainTarget[] {
    return agents.filter(
        (agent) => String(agent.name ?? '').trim().toLowerCase() !== NEVER_NUDGED_AGENT_NAME,
    );
}

/**
 * PURE. What a restart-to-apply must do first.
 *
 * *"No agent is killed by an upgrade without first being asked to stop and
 * write a handoff"* is a property of the RESTART PATH, not of a button. The
 * header pill, the staged-build banner and a remote `installUpdate` all end at
 * the same `restartAndApply`, so this is what each of them asks — one function,
 * so a new door cannot open without going through it.
 *
 * `liveAgents: null` means the probe could not answer. That resolves to `drain`,
 * because the two ways of being wrong are not symmetrical: guessing zero
 * applies the upgrade over live agents, which is the thing being prevented,
 * while guessing "some" costs a roster the user clears in one click.
 */
export function restartPlanForUpgrade(input: {
    /** Agent terminals the restart would tear down, or null when unknown. */
    liveAgents: number | null;
    /** Has a drain already run to completion for this restart? */
    drainComplete: boolean;
}): 'drain' | 'apply' {
    // The gate is the ROSTER, not the count. A drained agent is still counted
    // live at the instant the drain clears — the terminals have not been torn
    // down yet — so a plan that re-read the count here would never apply.
    if (input.drainComplete) return 'apply';
    return input.liveAgents === null || input.liveAgents > 0 ? 'drain' : 'apply';
}

/**
 * PURE. Should the QUIT still run its own readiness barrier?
 *
 * `teardownTerminals` asks every live agent to signal `thumbsUp(reason:
 * 'shutdown')` and waits 30 seconds for them. That is the right thing for a
 * full shutdown — but after a drain it is the same question, to the same
 * agents, with the same thumb, and every one of them has already answered it.
 * Asking again puts a second nudge in each agent's box on its way out and makes
 * the user watch a half-minute timeout at the end of an upgrade they just spent
 * time draining.
 *
 * Only an UPDATE quit that a drain actually cleared skips it. A reset, an
 * ordinary shutdown and any apply that skipped the drain keep the barrier they
 * have always had.
 */
export function shutdownReadinessPlan(input: {
    forUpdate: boolean;
    drainCleared: boolean;
}): 'ask' | 'skip' {
    return input.forUpdate && input.drainCleared ? 'skip' : 'ask';
}

/** Cancels an armed deadline. */
type Cancel = () => void;

export interface AgentDrainDeps {
    /** Put the nudge in the agent's inbox. Returns whether it landed. */
    send: (inboxAgentId: string, text: string) => boolean;
    /**
     * THIS agent's mode (genie#410). Optional and defensive for the same reason
     * the upgrade announcement's is: resolving it reads the database and a file
     * on disk, and neither may be able to cost an agent its nudge. A throw
     * degrades to {@link DEFAULT_AGENT_MODE}.
     */
    modeOf?: (agentId: string) => AgentMode;
    now?: () => number;
    /** The stuck deadline's clock, as an injected seam — tests fire it by hand
     *  rather than sitting through three real minutes. */
    schedule?: (run: () => void, delayMs: number) => Cancel;
    /** Pushed on begin and on every state change, so the roster UI never polls. */
    onChange?: (snapshot: DrainSnapshot) => void;
}

const defaultSchedule = (run: () => void, delayMs: number): Cancel => {
    const timer = setTimeout(run, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
};

/**
 * The drain's state machine. One at a time, by construction — a second drain
 * over the top of a running one would nudge every agent twice and leave two
 * rosters disagreeing about which upgrade is being held.
 */
export class AgentDrain {
    private rows = new Map<string, DrainRow>();
    private order: string[] = [];
    private startedAt = 0;
    private running = false;
    private settle: ((snapshot: DrainSnapshot) => void) | null = null;
    private disarm: Cancel | null = null;

    constructor(private readonly deps: AgentDrainDeps) {}

    active(): boolean {
        return this.running;
    }

    /**
     * Nudge every target and hold until the roster clears.
     *
     * Resolves with the final snapshot: `complete: true` when every row went
     * green, `false` when the drain was cancelled. It does NOT resolve on a
     * timeout — the deadline only re-LABELS a row, because proceeding on a
     * clock is the kill this replaces, wearing a delay.
     */
    begin(targets: readonly DrainTarget[], opts: { stuckAfterMs?: number } = {}): Promise<DrainSnapshot> {
        if (this.running) throw new Error('A drain is already running.');
        this.running = true;
        this.startedAt = this.now();
        this.rows.clear();
        this.order = [];

        for (const target of targets) {
            // A nudge that did not land means this agent was never asked, so
            // waiting on it is waiting on nothing. The roster says that rather
            // than showing an empty icon the user reads as "thinking".
            const landed = this.nudge(target);
            this.order.push(target.agentId);
            this.rows.set(target.agentId, {
                ...target,
                state: landed ? 'waiting' : 'stuck',
                satisfiedBy: null,
                note: landed
                    ? null
                    : 'Genie could not reach this agent — the nudge was not delivered, so it has ' +
                      'not been asked to stop. Shut it down yourself, then press its thumb.',
            });
        }

        const done = new Promise<DrainSnapshot>((resolve) => {
            this.settle = resolve;
        });
        this.emit();
        // Nothing to wait on: a drain with no live agents is already complete,
        // and arming a three-minute deadline over an empty roster would hold an
        // upgrade nobody is blocking.
        if (!this.finishIfClear()) {
            const schedule = this.deps.schedule ?? defaultSchedule;
            this.disarm = schedule(() => {
                this.disarm = null;
                this.markStuck();
            }, opts.stuckAfterMs ?? DRAIN_STUCK_AFTER_MS);
        }
        return done;
    }

    /** A `thumbsUp` landed. Only the drain's own targets move a row. */
    acknowledge(agentId: string, reason: 'boot' | 'ack' | 'shutdown'): void {
        // `boot` is a different signal entirely — an agent reporting it has
        // finished STARTING. Counting it here would let an agent relaunched
        // mid-drain satisfy a row it never drained.
        if (reason === 'boot') return;
        this.fill(agentId, 'ready', 'agent');
    }

    /**
     * The manual satisfy: the user shut this agent down by hand and pressed its
     * thumb. Recorded as the user's act, not the agent's — see the module note.
     */
    satisfy(agentId: string): void {
        this.fill(agentId, 'satisfied', 'user');
    }

    /** This agent's terminal died. Nothing is left to answer. */
    noteGone(agentId: string): void {
        this.fill(agentId, 'gone', null);
    }

    snapshot(): DrainSnapshot {
        const rows = this.order.map((id) => this.rows.get(id)!).filter(Boolean);
        return {
            active: this.running,
            startedAt: this.startedAt,
            rows,
            complete: rows.length > 0 && rows.every((row) => drainRowIsGreen(row.state)),
        };
    }

    /** Abandon the drain. Resolves the caller WITHOUT reporting it complete —
     *  a cancelled drain must never read as a satisfied one. */
    cancel(): void {
        if (!this.running) return;
        this.running = false;
        this.disarm?.();
        this.disarm = null;
        const snapshot = { ...this.snapshot(), active: false, complete: false };
        this.deps.onChange?.(snapshot);
        const settle = this.settle;
        this.settle = null;
        settle?.(snapshot);
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now();
    }

    private nudge(target: DrainTarget): boolean {
        let mode: AgentMode = DEFAULT_AGENT_MODE;
        try {
            mode = this.deps.modeOf?.(target.agentId) ?? DEFAULT_AGENT_MODE;
        } catch {
            // An unreadable mode is an UNDECLARED mode, and undeclared is
            // Manual. Losing the whole nudge over it would trade a wording
            // difference for a row that can only be cleared by hand.
            mode = DEFAULT_AGENT_MODE;
        }
        try {
            return this.deps.send(target.inboxAgentId, drainNudgeText(mode)) !== false;
        } catch {
            return false;
        }
    }

    /**
     * Move a row green, once.
     *
     * A row that is ALREADY green is left exactly as it is — a duplicate
     * `thumbsUp` (an agent that answers twice, or answers after a person has
     * pressed its thumb) must not overwrite who filled it in, and must not
     * re-run the completion check against a roster that has not changed.
     */
    private fill(agentId: string, state: DrainRowState, by: 'agent' | 'user' | null): void {
        if (!this.running) return;
        const row = this.rows.get(agentId);
        if (!row || drainRowIsGreen(row.state)) return;
        row.state = state;
        row.satisfiedBy = by;
        row.note = null;
        this.emit();
        this.finishIfClear();
    }

    /** The deadline fired: every row still waiting is stuck, and says why. */
    private markStuck(): void {
        if (!this.running) return;
        let changed = false;
        for (const row of this.rows.values()) {
            if (row.state !== 'waiting') continue;
            row.state = 'stuck';
            row.note =
                'This agent has not answered since it was asked to stop. It may be mid-turn, or ' +
                'it may be wedged — shut it down yourself, then press its thumb to let the ' +
                'upgrade proceed.';
            changed = true;
        }
        if (changed) this.emit();
    }

    private emit(): void {
        this.deps.onChange?.(this.snapshot());
    }

    /** Resolve the caller if the roster has cleared. Returns whether it did. */
    private finishIfClear(): boolean {
        const snapshot = this.snapshot();
        if (this.rows.size > 0 && !snapshot.complete) return false;
        this.running = false;
        this.disarm?.();
        this.disarm = null;
        const settle = this.settle;
        this.settle = null;
        settle?.({ ...snapshot, active: false, complete: true });
        return true;
    }
}
