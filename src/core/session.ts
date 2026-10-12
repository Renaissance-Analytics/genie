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
     * The provider could not be spoken to — a malformed frame, a failed handshake, a transport
     * that died mid-exchange.
     *
     * Dropping this is how a provider that cannot start becomes an agent that merely looks
     * idle, which is the most expensive possible rendering: indistinguishable from one that is
     * simply waiting for you.
     */
    onProtocolError?: (problem: string) => void;
    /** The provider's own output. Not a fault on its own — plenty of tools log here normally. */
    onStderr?: (line: string) => void;
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

/** How many lines of provider output to keep. Enough to explain a failure, bounded. */
const STDERR_KEPT = 50;

export interface AgentSessionOptions {
    agentId: AgentId;
    cwd: string;
    store: SessionStore;
    driverFactory: SessionDriverFactory;
    /** Resume this provider-side conversation instead of starting a fresh one. */
    resumeSessionId?: string | null;
    /**
     * Notified for every ledger row, so a surface can render without re-reading the thread.
     *
     * `meta.replacesLast` means this row SUPERSEDES the one emitted immediately before it: the
     * same message, with another chunk of text on the end. A reply arrives as a stream of
     * chunks and a reader watches it type, so each one is emitted — but they are one row, not
     * one row per frame.
     */
    onEvent?: (event: StreamEvent, meta?: { replacesLast: boolean }) => void;
    /**
     * Something a SURFACE renders has changed — a parked approval, an answered one, a turn
     * ending, a provider failing.
     *
     * Separate from `onEvent`, which is ledger rows. A parked approval is not a row: it happens
     * inside the driver's permission callback, changes what the Dashboard and the Deck both
     * show, and used to fire nothing at all. Measured in a real window: the session held a
     * pending approval while the screen showed nothing, and the agent was blocked on a human
     * who was never told.
     *
     * It would have surfaced eventually, on the next ledger row — which is the worst version of
     * the bug. It works in testing, where something else always happens next, and hangs in the
     * one case that matters, where the agent has stopped precisely BECAUSE it is waiting.
     *
     * Deliberately NOT fired for everything: a notification per stderr line from a chatty
     * provider would make the push channel the reason the app is slow. It fires when something
     * on screen would differ.
     */
    onStateChange?: () => void;
    /**
     * The provider has identified its own conversation, once.
     *
     * Fired when `cliSessionId` first becomes known — the value a later resume is keyed on, and
     * the thing the app has to write down for a thread to survive a restart at all. Separate
     * from `onStateChange` because it is not a redraw: nothing on screen changes, and the
     * listener's job is to persist.
     *
     * **Once.** A provider emits hundreds of updates per turn, and this firing on each would
     * be a disk write per token.
     */
    onSessionId?: (threadId: string) => void;
    /**
     * How a session reaps what the driver leaves behind. Injected so a test can assert the
     * reap happened without killing anything on the machine running the test.
     */
    processTree?: ProcessTree;
    /** Genie's clock, for the stamps below (when an approval parked, when a failure was recorded). Injected so a host's clock reaches them. */
    clock?: () => number;
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
    /** How the provider process ended, as node reported it. `null` until it exits. */
    #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    /** When the parked approval was parked, by Genie's clock — the pill's `waiting on you 0:42`. `null` when nothing is parked. */
    #parkedAt: number | null = null;
    /** When the failure was recorded, by Genie's clock — the pill's `Broken · stream closed 14:31`. Moves only with the reason. */
    #failedAt: number | null = null;
    /**
     * The provider's recent output, bounded.
     *
     * Where a provider usually explains itself — `command not found`, a bad flag, an expired
     * login. Bounded because a chatty provider in a process that stays up for days would
     * otherwise be an unbounded buffer; the LATEST lines are kept, since the last thing a
     * dying provider says is the useful part.
     */
    #stderr: string[] = [];
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
     * Whether we have SEEN the provider exit.
     *
     * Separate from {@link #alive} because it outranks the driver's own reading. `running`
     * prefers `driver.running` — correct, because a process can die without an exit event
     * reaching us and the driver is closer to it than our bookkeeping. But that preference
     * only makes sense in one direction: a driver answering `true` after we have watched it
     * exit is reporting a process that is gone, and there is no reading of an exit event that
     * leaves the provider alive.
     *
     * An exit is a fact; a `running` property is an opinion. The fact wins.
     */
    #exited = false;
    /** The session id already reported to the listener, so it is reported exactly once. */
    #reportedSessionId: string | null = null;
    /**
     * The message currently being streamed, if one is.
     *
     * **A reply is one row, not one row per frame.** It arrives as a stream of
     * `agent_message_chunk` updates, each of which was mapped to its own `message` row with
     * nothing joining them — so a recalled token came back as `zephyr-bfd` and `ae2b6` on two
     * separate rows, and `OK` as `O` then `K`. On screen that is a column of fragments, each
     * with its own speaker label and timestamp, where §4.2 says a message is one row of
     * speaker, time and text.
     *
     * Every test passed, because they all assert that *a* message row exists and renders. It
     * took a live check whose assertion used a random token: "does it remember" would have
     * been satisfied by `zephyr-bfd`.
     *
     * `persisted` tracks whether the thread already holds this message, so a growing message is
     * written once when it closes rather than once per chunk.
     */
    #openMessage: { event: Extract<StreamEvent, { kind: 'message' | 'think' }>; persisted: boolean } | null = null;
    /** Writes in flight, chained so the thread records rows in the order they were emitted. */
    #writes: Promise<void> = Promise.resolve();
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
        if (this.#exited) return false;
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

    /** The exit code or signal node reported when the provider process ended; `null` while it has not. */
    get exit(): { code: number | null; signal: NodeJS.Signals | null } | null {
        return this.#exit;
    }

    /** When the parked approval was parked (Genie's clock); `null` when nothing is parked. */
    get parkedAt(): number | null {
        return this.#parkedAt;
    }

    /** When the failure was recorded (Genie's clock); `null` without a failure. */
    get failedAt(): number | null {
        return this.#failedAt;
    }

    #now(): number {
        return this.#options.clock?.() ?? Date.now();
    }

    /** The provider's recent output, oldest first. Empty when it has said nothing. */
    get recentStderr(): readonly string[] {
        return this.#stderr;
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
        this.#parkedAt = null;
        held.resolve({ outcome: 'selected', optionId });
        this.#changed();
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
                onProtocolError: (problem) => {
                    this.#turnState = 'failed';
                    this.#changed();
                    /*
                     * The FIRST error, not the last.
                     *
                     * A failing handshake produces a cascade and the later entries are
                     * consequences — "transport closed" after "thread/start response did not
                     * contain thread.id" is the symptom reported over the cause. Same reason a
                     * stack trace is read from the top.
                     */
                    if (this.#failure === null) {
                        this.#failure = problem;
                        this.#failedAt = this.#now();
                    }
                },
                onStderr: (line) => {
                    // Kept, never promoted to a fault. Plenty of providers log here normally,
                    // and a build that painted every one of them red would teach people to
                    // ignore red.
                    this.#stderr = [...this.#stderr, line].slice(-STDERR_KEPT);
                },
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
                        this.#parkedAt = this.#now();
                        this.#options.onStateChange?.();
                    }),
                onTurnEnd: (outcome) => {
                    // Two turns are two replies even with nothing between them. Without this a
                    // whole conversation would accumulate into one unbounded row.
                    this.#closeMessage();

                    this.#turns += 1;
                    this.#changed();

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
                        this.#failedAt = this.#now();
                    } else {
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                    }
                },
                onExit: (code, signal) => {
                    // Persist whatever of the last reply arrived. A provider dying mid-sentence
                    // should cost the rest of the sentence, not the part it already said.
                    this.#closeMessage();

                    this.#alive = false;
                    this.#exited = true;
                    // Kept as node reported it — the one fact about the END of the process Genie actually has.
                    this.#exit = { code, signal };

                    /*
                     * **An exit is the end of the story, not an eraser.**
                     *
                     * `stopped` used to be unconditional here, and on its own that was right:
                     * an exit code says nothing about what the provider was DOING, so nothing
                     * claims it. The bug was that it also said nothing about what we had
                     * already been TOLD.
                     *
                     * Every failure ends in an exit. So `onProtocolError` would record the
                     * provider's own words and set `failed`, and milliseconds later this
                     * handler overwrote it with `stopped` — and `SessionHost.probe()` reports
                     * a failure only for `failed`, so the reason was dropped on the floor.
                     * The harder the failure, the more certainly its explanation vanished: a
                     * provider that could not spawn at all rendered as nothing whatsoever.
                     *
                     * Measured on CI, with a codex agent whose cwd did not exist: prism-acp
                     * said `failed to spawn Codex (Error)` and exited, and the screen showed
                     * `{"running":false,"turnState":"stopped","failure":null}`.
                     *
                     * A clean exit is still `stopped` — see the positive control in
                     * `test/session.test.ts`. Calling every exit a fault would paint a red row
                     * every time somebody stops an agent on purpose, which teaches people to
                     * stop reading red.
                     */
                    this.#turnState = this.#failure ? 'failed' : 'stopped';

                    /*
                     * And TELL somebody. This notified nobody, so a provider dying left its
                     * row reading `working` until some unrelated event pushed the next
                     * snapshot — and when a provider dies there is nothing next. Exactly the
                     * parked-approval defect, one handler along.
                     */
                    this.#changed();
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

    /**
     * `by` is who started the turn when the caller knows (`you` from the composer, `genie` for a reminder or a
     * handoff ask, a peer's name) — written into the ledger as the turn's marker, and `null` when nobody said.
     */
    prompt(text: string, by: string | null = null): void {
        if (!this.#driver) throw new Error('session is not started');
        // The marker lands BEFORE the provider's first frame, so every row that follows is inside this turn.
        void this.#emitRow({ kind: 'turn', n: this.#turns + 1, by });
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
        this.#parkedAt = null;

        const tree = this.#options.processTree ?? systemProcessTree;
        tree.killTree(this.#ownedPids);

        this.#alive = false;
        this.#turnState = 'stopped';
    }

    /** Tell whoever is watching that something a surface renders has changed. */
    /**
     * Report the provider's own session id the first time it is known.
     *
     * Read from the DRIVER rather than scraped out of the update: prism-acp already parses it
     * and exposes `cliSessionId`, and a second parser for the same field is a second thing to
     * be wrong. §2.1 — Genie never infers from bytes what the protocol reports.
     */
    #noticeSessionId(): void {
        const id = this.#driver?.cliSessionId ?? null;
        if (!id || id === this.#reportedSessionId) return;

        this.#reportedSessionId = id;
        this.#options.onSessionId?.(id);
    }

    /**
     * Finish the message being streamed and write it to the thread, once.
     *
     * Called when a different speaker starts, when any other kind of row arrives, when the turn
     * ends, and when the provider exits. Writing per chunk would put a row in the thread for
     * every few tokens, and reassembling them on read would mean the same joining rule
     * implemented in two places — which is how the two copies drift apart.
     */
    #closeMessage(): void {
        const open = this.#openMessage;
        this.#openMessage = null;
        this.#enqueue(open);
    }

    /**
     * Queue a finished message's write, preserving the order rows were emitted in.
     *
     * Writing per chunk would put a row in the thread for every few tokens, and reassembling
     * them on read would mean the same joining rule implemented in two places — which is how
     * two copies of one rule drift apart. So a message is written once, when it closes, and
     * the queue is what stops it landing after the row that closed it.
     *
     * A rejected write never breaks the chain: `then(fn, fn)` means the next write runs whether
     * the last one failed or not. A storage fault must not stop the conversation from being
     * recorded from then on — it is counted instead, so a surface can say this conversation is
     * not being saved.
     */
    #enqueue(open: { event: Extract<StreamEvent, { kind: 'message' | 'think' }>; persisted: boolean } | null): void {
        if (!open || open.persisted || open.event.text.length === 0) return;
        open.persisted = true;

        const write = async (): Promise<void> => {
            try {
                const thread = openAgentThread(this.#options.store, this.agentId);
                await thread.record([persistable(open.event)]);
            } catch {
                this.#unpersisted += 1;
            }
        };
        this.#writes = this.#writes.then(write, write);
    }

    #changed(): void {
        this.#options.onStateChange?.();
    }

    async #ingest(update: Record<string, unknown>): Promise<void> {
        /*
         * Checked BEFORE the early return below, and that ordering is the whole thing.
         *
         * The frame that carries the provider's session id is a `notice` — measured, from a
         * real codex: `notice: "Codex session started"` with the id in `_meta`. `toStreamEvent`
         * maps it to no ledger row, correctly, because nobody wants a row for it. So a check
         * placed after that return would never run on the one update that matters.
         */
        this.#noticeSessionId();

        const event = toStreamEvent(update);
        if (!event) return; // Deliberately not a ledger row (e.g. the slash-command menu).

        /*
         * A MESSAGE joins the one being streamed, when it is the same speaker.
         *
         * "The same speaker" is `speaker` AND `peerName`, not just `speaker`: `atlas -> wren`
         * and `kora -> wren` are both `peer`, and joining them would put one agent's words in
         * another's mouth. The owner's own `you` chunks merging into an agent's reply would
         * misattribute both.
         */
        /*
         * A MESSAGE joins the one being streamed, when it is the same speaker.
         *
         * "The same speaker" is `speaker` AND `peerName`, not just `speaker`: `atlas -> wren`
         * and `kora -> wren` are both `peer`, and joining them would put one agent's words in
         * another's mouth. The owner's own `you` chunks merging into an agent's reply would
         * misattribute both.
         *
         * **Emission is synchronous, writes are queued.** The first version awaited the
         * previous message's write before emitting, which moved every row into a microtask —
         * the renderer would have learned about a frame a tick after it arrived, and the whole
         * suite went quiet because nothing had been emitted yet by the time it asserted. A
         * surface should see a frame when it arrives; only the ORDER of what reaches the thread
         * has to be preserved, and `#enqueue` is what preserves it.
         */
        /*
         * A THOUGHT streams the same way (`agent_thought_chunk`, a few tokens per frame) and is one row for the same
         * reason: a column of one-line fragments is not "a thought, one line, never expanded" — it is the thought
         * chopped up, each piece with its own time. Consecutive thought chunks grow one row; anything else closes it.
         * While it is open and the turn is running, the surface shows it as the live `Thinking…` row.
         */
        if (event.kind === 'think') {
            const open = this.#openMessage;
            if (open && open.event.kind === 'think') {
                open.event = { ...open.event, text: open.event.text + event.text };
                this.#options.onEvent?.(open.event, { replacesLast: true });
                return; // Written to the thread once, when it closes.
            }
            this.#openMessage = { event, persisted: false };
            this.#options.onEvent?.(event, { replacesLast: false });
            this.#enqueue(open);
            return;
        }

        if (event.kind === 'message') {
            const open = this.#openMessage;
            if (open && open.event.kind === 'message' && open.event.speaker === event.speaker && open.event.peerName === event.peerName) {
                open.event = { ...open.event, text: open.event.text + event.text };
                this.#options.onEvent?.(open.event, { replacesLast: true });
                return; // Written to the thread once, when it closes.
            }

            // A different speaker: the previous message is finished, and must reach the thread
            // before this one does.
            this.#openMessage = { event, persisted: false };
            this.#options.onEvent?.(event, { replacesLast: false });
            this.#enqueue(open);
            return;
        }

        /*
         * Anything else CLOSES the open message.
         *
         * A reply, a tool call, then more reply is three rows in that order — which is the
         * point of a ledger. Joining across the tool call would reorder the account of what
         * happened, and the queue is what keeps the tool call from being written before the
         * words that preceded it.
         */
        await this.#emitRow(event);
    }

    /**
     * One row that is not a message chunk — from the wire or minted here (a turn marker): closes the open message,
     * reaches the renderer synchronously, and is written to the thread after the message it closed.
     */
    async #emitRow(event: StreamEvent): Promise<void> {
        const closing = this.#openMessage;
        this.#openMessage = null;

        this.#options.onEvent?.(event, { replacesLast: false });

        this.#enqueue(closing);

        try {
            const thread = openAgentThread(this.#options.store, this.agentId);
            await this.#writes; // The open message lands first, so the ledger keeps its order.
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
