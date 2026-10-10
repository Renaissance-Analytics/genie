import type { JsonObject, SessionStore } from '@particle-academy/prism-harness';
import { openAgentThread } from './thread-store.js';
import { approvalFrom, type Approval } from './approval.js';
import { toStreamEvent, type StreamEvent } from './stream-event.js';
import type { AgentId } from './identity.js';
import { systemProcessTree, type ProcessTree } from './process-tree.js';

/**
 * ONE RUNNING AGENT.
 *
 * Driver → mapper → thread, and nothing else. The session owns no pty, has no shell, and
 * holds no launch line; `prism-acp` spawns the provider CLI and speaks ACP to it, and what
 * arrives here is already a protocol event rather than bytes to be interpreted.
 *
 * **Genie never infers state from output.** No "silence means idle", no scraping a screen
 * for `(y/N)`. If the protocol does not report it, this module does not claim it — which is
 * why `turnState` has an `unknown` and why a stopped session reports `stopReason: null`
 * rather than inventing one.
 */

/** The slice of `prism-acp`'s driver this module needs. Narrow on purpose — it is the seam. */
export interface SessionDriver {
    start(): void;
    prompt(text: string): void;
    kill(signal?: NodeJS.Signals): void;
    /**
     * OPTIONAL, and that is a measurement rather than a guess.
     *
     * In `prism-acp` 0.6.1 `ClaudeDriver` has a `running` getter and **`CodexDriver` does
     * not** — and the shared `AgentDriver` interface does not declare one either. This used to
     * be required, read as `driver?.running ?? false`, which for codex answered
     * `undefined ?? false`: a working codex agent reporting **not running**. On the Dashboard
     * that is `idle` with no duration — an agent burning tokens while the board says nothing
     * is happening.
     *
     * Nothing caught it because every test used a fake driver that had the property.
     */
    readonly running?: boolean;
    readonly cliSessionId: string | null;
}

/** A turn's outcome, as `prism-acp` reports it. */
export interface TurnOutcomeLike {
    /**
     * `null` when the turn did NOT finish cleanly.
     *
     * Deliberate in prism-acp and honoured here: ACP's five stop reasons all describe a turn
     * that finished, and none of them describes a crash. Answering `end_turn` for a failed
     * turn would report a clean finish that never happened.
     */
    readonly stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | null;
    readonly isError: boolean;
    /** The CLI's own reason string, kept even when it maps to nothing. */
    readonly raw: string | null;
}

/** ACP's permission request, as the driver hands it over. Both fields are open records. */
export interface PermissionRequestLike {
    readonly toolCall: Record<string, unknown>;
    readonly options: readonly Record<string, unknown>[];
}

export type PermissionOutcomeLike =
    | { readonly outcome: 'selected'; readonly optionId: string }
    | { readonly outcome: 'cancelled' };

export interface DriverEvents {
    onUpdate?: (update: Record<string, unknown>) => void;
    /**
     * The provider is asking a human to decide, and **it is blocked on the promise this
     * returns.** Resolving it is literally how the agent is unblocked.
     *
     * Which is why nothing here resolves it eagerly with a default: that would auto-approve
     * every tool call and leave the approval UI as decoration over an agent that never
     * actually waited.
     */
    onRequestPermission?: (request: PermissionRequestLike) => Promise<PermissionOutcomeLike>;
    /**
     * A TURN ended. **Not the same event as the process exiting.**
     *
     * With `--input-format stream-json` the CLI stays alive across turns, so without this
     * signal a session goes to `working` on the first prompt and never comes back: every
     * agent anyone had ever prompted would read `Working` on the Dashboard forever, with a
     * duration counting up beside it. prism-acp keeps the two events separate for exactly
     * this reason.
     */
    onTurnEnd?: (outcome: TurnOutcomeLike) => void;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Builds the driver for a run.
 *
 * Injected rather than imported so a test can drive this module without spawning a provider
 * CLI — and so the real one can be swapped per provider without this file growing a switch
 * on a provider name.
 */
export type SessionDriverFactory = (options: {
    cwd: string;
    /** Present on a RESUME. `prism-acp` takes it as a constructor option, not a method. */
    resumeSessionId?: string;
    events: DriverEvents;
}) => SessionDriver;

/**
 * What the session is doing, as far as the PROTOCOL has said.
 *
 * `unknown` is a real member and is never a synonym for idle: it means nothing has told us,
 * and a surface renders it as "we cannot see" rather than as "nothing is happening".
 */
export type TurnState = 'idle' | 'working' | 'failed' | 'stopped' | 'unknown';

export interface AgentSessionOptions {
    agentId: AgentId;
    cwd: string;
    store: SessionStore;
    driverFactory: SessionDriverFactory;
    /** Resume this provider-side conversation instead of starting a fresh one. */
    resumeSessionId?: string | null;
    /** Notified for every ledger row, so a surface can render without re-reading the thread. */
    onEvent?: (event: StreamEvent) => void;
    /**
     * How a session reaps what the driver leaves behind. Injected so a test can assert the
     * reap happened without killing anything on the machine running the test.
     */
    processTree?: ProcessTree;
}

export class AgentSession {
    readonly agentId: AgentId;

    #driver: SessionDriver | null = null;
    #turnState: TurnState = 'idle';
    #options: AgentSessionOptions;
    /** Rows that failed to persist. Kept so a storage fault is reportable, never silent. */
    #unpersisted = 0;
    /** Completed turns, failed ones included — a failed turn still happened and still cost. */
    #turns = 0;
    /** The provider's own words for why a turn did not finish. `null` when none did. */
    #failure: string | null = null;
    /**
     * This session's own subtree, captured just after start.
     *
     * Recorded as the DIFFERENCE against the descendants that existed a moment before, so a
     * stop can never reach into a sibling session's processes. On a workstation running a
     * dozen agents that distinction is the difference between stopping one and stopping the
     * room.
     */
    #ownedPids: readonly number[] = [];
    /**
     * Our own record of whether the provider is alive: true from `start`, false on exit or
     * stop. Used when the driver does not expose `running` — see {@link SessionDriver.running}.
     */
    #alive = false;
    /**
     * The approval a human has not answered yet, and the resolver the PROVIDER is blocked on.
     *
     * Held together because they are one fact: a parked approval that nobody can resolve is a
     * provider process waiting forever, and a resolver with no question is a decision nobody
     * made.
     */
    #approval: { approval: Approval; resolve: (outcome: PermissionOutcomeLike) => void } | null = null;

    constructor(options: AgentSessionOptions) {
        this.#options = options;
        this.agentId = options.agentId;
    }

    get turnState(): TurnState {
        return this.#turnState;
    }

    /** `null` until the provider reports one. It is what a later resume is keyed on. */
    get cliSessionId(): string | null {
        return this.#driver?.cliSessionId ?? null;
    }

    /**
     * Whether the provider is alive.
     *
     * The driver's own reading is preferred when it has one: a provider process can die
     * without an exit event reaching us, and `ClaudeDriver.running` is closer to the truth
     * than our bookkeeping. When the driver has no such property — `CodexDriver` — we fall
     * back to what we know for certain, which is that we started it and have not seen it end.
     *
     * What this never does is answer `false` because the property was missing.
     */
    get running(): boolean {
        if (!this.#driver) return false;
        return this.#driver.running ?? this.#alive;
    }

    get unpersistedEvents(): number {
        return this.#unpersisted;
    }

    /** Turns this session has completed. The Budget panel's count comes from here. */
    get turns(): number {
        return this.#turns;
    }

    /** Why the last turn failed, in the provider's own words, or `null`. */
    get failure(): string | null {
        return this.#failure;
    }

    /** The question waiting on a human, or `null`. This is what makes a row `waiting`. */
    get pendingApproval(): Approval | null {
        return this.#approval?.approval ?? null;
    }

    /**
     * Answer the parked approval. Returns false if there was nothing to answer, or if the id
     * was not one the request offered.
     *
     * **The id is checked against the request.** The renderer is not trusted to send back a
     * valid one, and a provider receiving an option it never offered is a protocol error at
     * best. A refused answer leaves the approval parked, which is recoverable; "answered with
     * something meaningless" is not.
     */
    answerApproval(optionId: string): boolean {
        const held = this.#approval;
        if (!held) return false;
        if (!held.approval.options.some((o) => o.id === optionId)) return false;

        this.#approval = null;
        held.resolve({ outcome: 'selected', optionId });
        return true;
    }

    start(): void {
        if (this.#driver) return; // Reattach, never a second copy of the same agent.

        const { cwd, resumeSessionId, driverFactory } = this.#options;
        this.#driver = driverFactory({
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            events: {
                onUpdate: (update) => void this.#ingest(update),
                onRequestPermission: (request) =>
                    new Promise<PermissionOutcomeLike>((resolve) => {
                        const approval = approvalFrom(request);

                        // A request with no readable options cannot be answered by anybody.
                        // Parking it would show a question with no buttons and block the agent
                        // on a human who has no way to reply; cancelling returns a decision the
                        // provider understands.
                        if (!approval) {
                            resolve({ outcome: 'cancelled' });
                            return;
                        }

                        // One at a time. A second request while one is parked would orphan the
                        // first resolver — a provider waiting forever on a promise nobody holds.
                        this.#approval?.resolve({ outcome: 'cancelled' });
                        this.#approval = { approval, resolve };
                    }),
                onTurnEnd: (outcome) => {
                    this.#turns += 1;

                    // A turn that did not finish cleanly is `failed`, not `idle`. Reporting
                    // idle would present a crashed turn as a completed one, which is the
                    // quietest way to lose work: the agent stops, the board says nothing is
                    // wrong, and nobody looks.
                    //
                    // A CANCELLED turn is the exception and is idle: cancelling is something
                    // the human did, and painting it as a fault blames the agent for being
                    // stopped.
                    const crashed = outcome.stopReason === null || outcome.isError;
                    if (crashed) {
                        this.#turnState = 'failed';
                        this.#failure = outcome.raw;
                    } else {
                        this.#turnState = 'idle';
                        this.#failure = null;
                    }
                },
                onExit: () => {
                    // The provider ended. `stopped` is a fact; what it was DOING when it
                    // ended is not knowable from an exit code, so nothing claims it.
                    this.#alive = false;
                    this.#turnState = 'stopped';
                },
            },
        });
        const tree = this.#options.processTree ?? systemProcessTree;
        const before = new Set(tree.descendantsOf(process.pid));
        this.#driver.start();
        this.#ownedPids = tree.descendantsOf(process.pid).filter((pid) => !before.has(pid));
        this.#alive = true;
        this.#turnState = 'working';
    }

    prompt(text: string): void {
        if (!this.#driver) throw new Error('session is not started');
        this.#driver.prompt(text);
        this.#turnState = 'working';
    }

    /**
     * End the run.
     *
     * The previous build's stop reported success while leaving the provider alive, so the
     * owner had agents they could not stop. Here `stop()` resolves only once the driver
     * reports it is no longer running, and a caller is expected to verify by process scan at
     * the integration level — a return value is not evidence.
     */
    stop(signal: NodeJS.Signals = 'SIGTERM'): void {
        this.#driver?.kill(signal);

        /**
         * Then reap this session's own subtree, as defence in depth.
         *
         * Measured 2026-10-10: `driver.kill('SIGTERM')` already terminates the whole provider
         * tree, so this is normally a no-op. It is kept because "stop means stop" is the one
         * promise the previous build broke — it returned success while the owner's agents
         * kept running — and a signal is not guaranteed to reach a detached grandchild or a
         * provider that re-parents.
         *
         * Only this session's own subtree is touched. NEVER a name sweep: this machine runs
         * a dozen agents at once, and a sweep would stop the room rather than one agent.
         */
        // A promise nobody will ever resolve is a provider process waiting forever. `stop`
        // means stop, and that has to include the things stop is waiting ON.
        this.#approval?.resolve({ outcome: 'cancelled' });
        this.#approval = null;

        const tree = this.#options.processTree ?? systemProcessTree;
        tree.killTree(this.#ownedPids);

        this.#alive = false;
        this.#turnState = 'stopped';
    }

    async #ingest(update: Record<string, unknown>): Promise<void> {
        const event = toStreamEvent(update);
        if (!event) return; // Deliberately not a ledger row (e.g. the slash-command menu).

        this.#options.onEvent?.(event);

        try {
            const thread = openAgentThread(this.#options.store, this.agentId);
            await thread.record([persistable(event)]);
        } catch {
            // A storage fault must not take the turn down with it — but it must also not
            // vanish. Counted, so a surface can say "this conversation is not being saved"
            // instead of quietly holding a partial history.
            this.#unpersisted += 1;
        }
    }
}

/**
 * A ledger row as the thread can actually store it.
 *
 * `StreamEvent` carries two fields typed `unknown` on purpose — a tool call's `rawInput`
 * and a plan's entries are whatever the provider sent, and narrowing them would be
 * asserting a shape we were not given. The store wants JSON, so they are round-tripped:
 * anything not representable (a function, a cycle, a BigInt) becomes `null` rather than
 * throwing mid-turn and taking the conversation down with it.
 *
 * Deliberately NOT a cast. `as unknown as JsonObject` would compile and then write
 * something the store cannot read back, which is the quiet kind of data loss — the same
 * shape of defect as an identity split: nothing throws, and the damage is only visible
 * much later.
 */
function persistable(event: StreamEvent): JsonObject {
    try {
        return JSON.parse(JSON.stringify(event)) as JsonObject;
    } catch {
        // A cyclic `rawInput` is the realistic case. Keep the row and its kind — losing
        // payload is survivable, losing the fact that the event happened is not.
        return { kind: event.kind, unserialisable: true } as JsonObject;
    }
}
