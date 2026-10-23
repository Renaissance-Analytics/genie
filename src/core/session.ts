import type { SessionModelState } from '@particle-academy/prism-acp';
import type { JsonObject, SessionStore } from '@particle-academy/prism-harness';
import { lastTurnOf, openAgentThread, readHistory, RUN_FIELD } from './thread-store.js';
import { approvalFrom, type Approval } from './approval.js';
import { approvalNoteText } from './approval-note.js';
import { toStreamEvent, type NoticeMail, type StreamEvent } from './stream-event.js';
import { extensionsFrom, type ProviderExtensions } from './provider-commands.js';
import type { AgentId } from './identity.js';
import type { PromptBlock } from './prompt-content.js';
import { describeProcesses, newChildrenOf, stillRunning, subtreeOf, systemProcessTree, unionOf, type ProcessInfo, type ProcessTree } from './process-tree.js';
import { limitReadingsFromMeta, type LimitReading } from './rate-limit-gate.js';
import { RATE_LIMIT_META } from './headroom.js';
import { accountPauseOf, type AccountPause } from './account-pause.js';
import { designLoginRefused } from './design-login.js';
import { randomUUID } from 'node:crypto';

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
    /** Text, or ACP prompt content blocks when files are attached (prism-acp's `prompt`). */
    prompt(content: string | readonly PromptBlock[]): void;
    kill(signal?: NodeJS.Signals): void;
    /**
     * CLOSE THE PROVIDER'S STDIN — prism-acp's `endInput()`: "tells the CLI no more turns are coming". Claude ends on its
     * own once it has finished, which is what lets it flush its conversation before a restart resumes it. Optional: a
     * fake driver has none, and Codex's is a no-op (its app server has no stdin close) — the host decides whether a
     * provider gets a grace at all (`gracefulEndFor`).
     */
    endInput?(): void;
    /**
     * END THE RUN'S WHOLE TREE — prism-acp 0.21's `stop({ graceMs })`: closes stdin, waits the grace, terminates the
     * supervised tree (a Job Object on Windows, a process group elsewhere) and resolves with what it found. Optional: a
     * fake driver, or an older prism, has none, and the session closes stdin and kills as before. Genie verifies the
     * result with its own reading either way (`AgentSession.stop`).
     */
    stop?(options?: { graceMs?: number }): Promise<unknown>;
    /**
     * END THE CURRENT TURN AND KEEP THE SESSION — prism-acp's `AgentDriver.cancel?()` (0.14.0, prism-acp-ts#16/#17).
     * The provider is asked to interrupt; the turn then ends through `onTurnEnd` with `stopReason: 'cancelled'`, and the
     * process, its session and its conversation stay. With no turn running the driver does nothing. A rejection is the
     * provider refusing the interrupt (Codex answering `turn/interrupt` with an error, a closed stdin for Claude).
     *
     * OPTIONAL because it is: prism-acp declares it optional, and before 0.14.0 neither driver had it. A driver without
     * it cannot stop a turn, and `AgentSession.cancel` says so rather than killing the agent in its place — killing it
     * was the bug (the owner, 2026-10-15: "it killed the agent, not stopping the chat").
     */
    cancel?(): Promise<void> | void;
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
    /**
     * OPTIONAL: resolves once the provider can take a turn — a driver that has a start-up handshake DECLARES it
     * (prism-acp's `CodexDriver.ready`: "Resolves once initialize and thread start/resume have completed"); one that
     * declares nothing is ready when started (`ClaudeDriver`). Read after `start()`, never before: the promise is the
     * one that start began. Genie holds its own turns (the inbox push) until then rather than lean on what a driver
     * does with a prompt sent before it is ready.
     */
    readonly ready?: Promise<void>;
    /**
     * THE PROVIDER'S MODELS, AND THIS SESSION'S — prism-acp 0.22's `modelState()` (Claude: from the `initialize` it sends
     * at start; Codex: `model/list` on its running app server). No extra process, no turn. Optional: a fake driver, or an
     * older prism, has none, and the picker asks the provider's CLI instead (core/provider-models.ts).
     */
    modelState?(): Promise<SessionModelState>;
    /**
     * SWITCH THE RUNNING SESSION'S MODEL — prism-acp 0.22's `setModel(id)`. Claude's CLI switches at once (control
     * `set_model`); Codex sends it with the next turn. Rejects when the provider refuses. Optional for the same reason:
     * without it the choice applies by a restart on the same conversation, as before.
     */
    setModel?(modelId: string): Promise<void>;
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
    /**
     * Why a failed turn failed, in the provider's own words (prism-acp 0.18, Tynn #791): Claude's assistant `error`,
     * codex's `codexErrorInfo`, verbatim as `reason`, sorted into a `kind`. `rate_limit` is a turn the limit ended.
     */
    readonly failure?: { readonly reason: string; readonly kind: string; readonly resetsAtMs?: number };
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
    onProtocolError?: (problem: string, detail?: { readonly recoverable: boolean }) => void;
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

/**
 * What a turn's Stop got (`AgentSession.cancel`). `ok: true` means the provider was ASKED; the turn is over when it
 * reports a cancelled turn end, not before.
 * - `not-running`: no session (never started, stopped, or exited) — nothing to stop.
 * - `no-turn`: the session is up and between turns — nothing to stop, and nothing was sent.
 * - `unsupported`: this driver cannot end a turn on its own; the turn runs on, and the agent was NOT killed instead.
 * - `refused`: the driver threw on the ask; the turn runs on, said in the stream. (A refusal that arrives LATER — the
 *   provider rejecting the interrupt — is said in the stream the same way; the call had already answered `ok`.)
 */
export type CancelOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: 'not-running' | 'no-turn' | 'unsupported' | 'refused' };

/**
 * How a stop ended (`AgentSession.stop`). `verified` only when a fresh reading shows every process the run was seen to
 * own is gone. Unverified says why, and names what is still running (`survivors`, empty when it could not look).
 */
export type StopVerdict =
    | { readonly verified: true; readonly ended: number }
    | { readonly verified: false; readonly reason: string; readonly survivors: readonly ProcessInfo[] };

/** How many lines of provider output to keep. Enough to explain a failure, bounded. */
const STDERR_KEPT = 50;

/** How many of the last stderr lines a failed run's ledger notice carries, and the notice's ceiling in characters. */
const FAILED_RUN_STDERR = 12;
const FAILED_RUN_MAX = 3000;

/** The one ledger line a failed run leaves: what failed, how the process ended, and the provider's last words. */
export function failedRunText(failure: string, code: number | null, signal: string | null, stderr: readonly string[]): string {
    const exit = signal ? `ended by ${signal}` : code === null ? 'exit unknown' : `exit code ${code}`;
    const tail = stderr.slice(-FAILED_RUN_STDERR).join('\n');
    const text = `The run failed: ${failure} (${exit}).${tail ? `\nLast lines the provider wrote:\n${tail}` : ''}`;
    return text.length > FAILED_RUN_MAX ? `${text.slice(0, FAILED_RUN_MAX - 1)}…` : text;
}

/** What a held agent is told when its provider's limit has reset and nothing was sent while it waited (Tynn #793). */
export const LIMIT_RESUME_PROMPT = "The provider's rate limit has reset. Continue where you left off.";

/**
 * AN OVERLOADED PROVIDER IS WAITED OUT (the owner, 2026-10-23, a Codex agent "Broken · 8h 45m · serverOverloaded": "we
 * need to catch codex errors like this one"). prism-acp sorts Codex's `serverOverloaded` and Claude's 529 into
 * `failure.kind: 'overloaded'`. It is the provider's and it passes, so the agent is not Broken: Genie waits these long,
 * in turn, and sends the turn on again; the overload after the last of them IS Broken, with the reason.
 */
export const OVERLOAD_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000];
export const OVERLOAD_RESUME_PROMPT = 'The provider was overloaded and your last turn did not finish. Continue where you left off.';

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
     * The agent's turns so far, when KNOWN at start (its record's `lastTurn`): the first turn is numbered on from it at
     * once. Absent = counted from the recorded history, which is read asynchronously.
     */
    turnsBefore?: number | undefined;
    /**
     * This run's id, written on every row it records (thread-store `RUN_FIELD`), so a later read can tell this run's rows
     * from the ones before it by what they say, never by when they landed. Absent: rows carry none (told apart by time).
     */
    runId?: string;
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
     * The provider's rate-limit readings, as they arrive (Tynn #792/#793): what the host's gate for this login is fed.
     * `message` is the notice's own words, when it had any.
     */
    onRateLimit?: (readings: readonly LimitReading[], message: string | null) => void;
    /**
     * A turn the provider ended on its rate limit with NO reading before it (Tynn #791): the gate has no reset to wait
     * for and holds the login on its stated backoff. `reason` is the provider's own.
     */
    onLimitBreach?: (reason: string) => void;
    /**
     * How a session reaps what the driver leaves behind. Injected so a test can assert the
     * reap happened without killing anything on the machine running the test.
     */
    processTree?: ProcessTree;
    /**
     * The run's OWN processes, once known at start — the new direct child of Genie the driver spawned and its tree
     * (hosting plan 1.2). What the host writes into its spawn ledger, so a crash cannot orphan them unrecorded.
     */
    onSpawned?: (processes: readonly ProcessInfo[]) => void;
    /** Output arrived from this run after it was stopped (hosting plan 1.4). Said once per run. */
    onStraggler?: () => void;
    /** Genie's clock, for the stamps below (when an approval parked, when a failure was recorded). Injected so a host's clock reaches them. */
    clock?: () => number;
    /** Run `fire` after `ms`; answers a cancel. Injected so a test can fire it; default `setTimeout`. */
    retryLater?: (ms: number, fire: () => void) => () => void;
}

export class AgentSession {
    readonly agentId: AgentId;

    #driver: SessionDriver | null = null;
    #held = false;
    /** A non-allowed rate-limit reading arrived during the turn now running. */
    #limitThisTurn = false;
    /** Prompts sent while held: recorded as sent, handed to the provider on resume. */
    /** Overloaded turns in a row (OVERLOAD_RETRY_MS); a turn that goes through resets it. */
    #overloads = 0;
    #overloadCancel: (() => void) | null = null;
    #heldPrompts: Array<{ text: string; by: string | null; sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null }> = [];
    #turnState: TurnState = 'idle';
    #options: AgentSessionOptions;
    /** Rows that failed to persist. Kept so a storage fault is reportable, never silent. */
    #unpersisted = 0;
    /** Completed turns, failed ones included — a failed turn still happened and still cost. */
    #turns = 0;
    /**
     * The number of the last turn MARKER written. A turn cut off before it ended (an exit, a quit) still took its
     * number, so the next turn numbers on from here, not from the turns that ended — which used to number it again.
     */
    #marked = 0;
    #lastTurnEnd: 'replied' | 'stopped' | 'failed' | 'held' | 'signed-out' | null = null;
    /** The provider said this login is not signed in (prism-acp `failure.kind: 'auth'`): a login fixes it, not a restart. */
    #signedOut = false;
    /** The provider refused the ACCOUNT (billing, on hold, subscription access off — core/account-pause.ts): nothing here fixes it. */
    #accountPaused: AccountPause | null = null;
    /** A tool was refused for want of Claude Design's `/design-login` (core/design-login.ts): the login window fixes it. */
    #designLogin = false;
    /**
     * ONE PROMPT, ONE TURN. A prompt sent while a turn runs does not start a turn there: the provider queues it (Claude
     * runs it as its own turn after the current one; Codex refuses a second prompt in flight). Its marker is written
     * when ITS turn starts — when the one before it ends. Writing it at send time numbered it as the running turn, so
     * the owner's record read `10, 10, 10, 10, 11, 12, 14, 14…`: the same number per message sent mid-turn, and a gap for
     * every queued turn that ended without a marker (the owner, 2026-10-14).
     */
    #inTurn = false;
    /** Who sent each prompt still waiting for its turn (`by`, as `prompt` takes it), oldest first. */
    #queued: (string | null)[] = [];
    /**
     * Who asked to stop the running turn (`cancel`'s `by`), until that turn ends. The cancelled turn's end is then
     * recorded as stopped BY them; a turn the provider reports cancelled with nobody here asking is recorded `by: null`.
     */
    #stopAskedBy: string | null = null;
    /** Turns ENDED in this run only. `#turns` carries on from the recorded history (#223); a wait for an answer must not. */
    #endedThisRun = 0;
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
     * THIS RUN'S OWN PROCESSES (hosting plan 1.2): the processes that were NEW, DIRECT children of Genie across the
     * driver's spawn — `cmd.exe` on Windows (prism-acp spawns through it), the provider itself elsewhere. `null` when the
     * machine could not be read at start.
     *
     * Never "everything that appeared under Genie between two scans": that diff claimed another agent's Bash tool, a
     * terminal's command, a php-cgi — whatever started in the same instant — and a stop would have killed it. Another
     * agent's tool and a terminal's command appear DEEPER, under their own parents; only the spawn makes a new direct
     * child. A stop reaches the roots' tree AS IT IS THEN, so a provider the shell launched later is still reached.
     */
    #roots: readonly ProcessInfo[] | null = null;
    /** Every process of this run seen so far (the roots' trees at start and at stop) — what a verification checks. */
    #members: readonly ProcessInfo[] = [];
    /**
     * THE RUN IS OVER (hosting plan 1.4). Set by `stop()`; from then on the old driver's events are not this agent's
     * any more: output is dropped (and said once), an approval is answered `cancelled`, a protocol error is ignored. A
     * straggler used to keep writing rows into the agent's thread beside the next run.
     */
    #ended = false;
    #stragglerNoted = false;
    /** The stop in progress, so a second `stop()` waits for the same one. */
    #stopping: Promise<StopVerdict> | null = null;
    /** How the stop ended, once known — synchronously, when it needed no grace and no retry. */
    #verdict: StopVerdict | null = null;
    /** Whoever waits for the provider's exit (a graceful stop's grace). */
    #exitWaiters: Array<() => void> = [];
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
    /** Still starting: the driver declared a `ready` that has not resolved. No turn of Genie's own is sent until it has. */
    #starting = false;
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
    /** The prompt just sent, while its echo may still arrive, and how much of the echo has arrived. */
    #echo: string | null = null;
    #echoSeen = '';
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

    /** The agent's commands, skills, plugins and subagents, as its CLI last reported them (core/provider-commands.ts). */
    #extensions: ProviderExtensions | null = null;

    constructor(options: AgentSessionOptions) {
        this.#options = options;
        this.agentId = options.agentId;
        if (options.turnsBefore !== undefined && options.turnsBefore >= 0) { this.#turns = options.turnsBefore; this.#marked = options.turnsBefore; }
    }

    /**
     * HELD FOR THE PROVIDER'S RATE LIMIT (Tynn #793): the turn the limit ended is not a failure, and a prompt sent now
     * waits here — a provider at its limit would only refuse it. `resumeAfterLimit` sends what waited.
     */
    get held(): boolean { return this.#held; }
    /** Signed out of its provider: the person logs in (the header's `Log in`), and Genie brings it back. */
    get signedOut(): boolean { return this.#signedOut; }
    /** Its account is paused by the provider: the person puts the account right, then `Try again`. `null` = not paused. */
    get accountPaused(): AccountPause | null { return this.#accountPaused; }
    /** Waiting on the Claude Design login (#1081): the header's `Log in to Claude Design`, once per login. */
    get designLogin(): boolean { return this.#designLogin; }

    /** The Claude Design login window ended: no longer waiting. Refused again, the next refusal raises it again. */
    designLoginRan(): void {
        if (!this.#designLogin) return;
        this.#designLogin = false;
        this.#changed();
    }

    /** Hold an agent whose LOGIN is at its limit (another agent hit it): its next prompts wait too. */
    hold(): void {
        if (this.#held) return;
        this.#held = true;
        this.#changed();
    }

    /** The limit has reset (the gate's timer, or the person's Resume now): what waited goes out in order; nothing waited -> continue. */
    resumeAfterLimit(): void {
        this.#resumeHeld(LIMIT_RESUME_PROMPT);
    }

    /** What waited goes out in order; nothing waited -> `nothingWaited`, as Genie's. */
    #resumeHeld(nothingWaited: string): void {
        if (!this.#held) return;
        this.#held = false;
        this.#overloadCancel?.();
        this.#overloadCancel = null;
        const waiting = this.#heldPrompts;
        this.#heldPrompts = [];
        if (waiting.length === 0) {
            this.prompt(nothingWaited, 'genie');
            return;
        }
        for (const p of waiting) this.#send(p.text, p.by, p.sent);
        this.#changed();
    }

    get turnState(): TurnState {
        return this.#turnState;
    }

    /**
     * Whether the session can take a turn NOW — Genie's own reading, the same for every provider: alive, started (the
     * driver's declared `ready`, when it declares one), no turn in flight (Genie's own record, `#inTurn` — never inferred
     * from output), nothing parked on a person, and not broken or stopped. What the inbox push waits for.
     *
     * Deliberately not `turnState === 'idle'`. A session just started reads `working` until a turn of its own ends — with
     * no turn running — so a notice for an agent started and mailed at once waited for somebody else to prompt it (B26).
     */
    get promptable(): boolean {
        return this.running && !this.#starting && !this.#inTurn && this.#approval === null && this.#turnState !== 'failed' && this.#turnState !== 'stopped';
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
        // Stopped: the run is over for Genie, whatever the provider is still doing in its grace.
        if (this.#ended) return false;
        return this.#driver.running ?? this.#alive;
    }

    get unpersistedEvents(): number {
        return this.#unpersisted;
    }

    /**
     * Resolves once every row this session has queued for its thread has been written — or counted as unpersisted.
     *
     * A row reaches the ledger SYNCHRONOUSLY and the thread LATER (`#emitRow`, `#enqueue`): the screen is never kept
     * waiting on a disk. So "the row is on screen" says nothing about "the row is on disk", and before this there was no
     * way to ask. A test that tore its store folder down the moment a row showed raced the session's own write (a lock
     * file, a temporary file, the folder itself re-created by the write): agent-history's afterEach and turn-end-notify's
     * afterAll each failed about one full suite in three (2026-10-15; the error text was not captured — a recursive remove
     * racing a create fails ENOTEMPTY, which is what to look for).
     *
     * Waits until the chain stops growing, so a row queued while an earlier one was being written is waited for too.
     * Never rejects: a failed write is counted (`unpersistedEvents`), not thrown, which is what the chain already does.
     */
    async settled(): Promise<void> {
        let tail: Promise<void>;
        do {
            tail = this.#writes;
            await tail;
        } while (tail !== this.#writes);
    }

    /** Turns this session has completed. The Budget panel's count comes from here. */
    get turns(): number {
        return this.#turns;
    }

    /** The number of the last turn this agent STARTED — what its record keeps, so its next run numbers on from it. */
    get lastTurn(): number {
        return Math.max(this.#marked, this.#turns);
    }

    /** The next turn's number, taken now: one past every turn started or ended. */
    #nextTurn(): number {
        this.#marked = Math.max(this.#marked, this.#turns) + 1;
        return this.#marked;
    }

    /** Turns that ended in THIS run — never the recorded history's. What a caller waiting on an answer counts. */
    get turnsEndedThisRun(): number {
        return this.#endedThisRun;
    }

    /** How the last turn ended — a reply, stopped by someone, failed, or held by a rate limit — `null` before any has. */
    get lastTurnEnd(): 'replied' | 'stopped' | 'failed' | 'held' | 'signed-out' | null {
        return this.#lastTurnEnd;
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
    /** What the agent's own CLI can run, as it last reported; `null` until it reports. */
    get extensions(): ProviderExtensions | null {
        return this.#extensions;
    }

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
    answerApproval(optionId: string, note = ''): boolean {
        const held = this.#approval;
        if (!held) return false;
        if (!held.approval.options.some((o) => o.id === optionId)) return false;

        this.#approval = null;
        this.#parkedAt = null;
        held.resolve({ outcome: 'selected', optionId });
        // THE DECISION IS A LEDGER ROW: what was decided about which call, kept with the conversation (the chips row's
        // Approvals, the ledger's history). The request was state until now; the answer is a fact worth a line.
        const chosen = held.approval.options.find((o) => o.id === optionId);
        const outcome = chosen?.tone === 'ok' ? 'allowed' : chosen?.tone === 'bad' ? 'denied' : 'answered';
        const trimmed = note.trim();
        void this.#emitRow({ kind: 'approval', question: held.approval.question, tool: held.approval.tool ?? null, outcome, optionId, ...(trimmed ? { note: trimmed } : {}) });
        /*
         * THE NOTE REACHES THE AGENT (beta.33 item 16; the owner: "I rejected with a note in the rejection but compass did
         * not get the rejection notice"). ACP's outcome has no note, so the note goes as the person's own message, through
         * the chat prompt's path: Claude reads it at its next step. A provider that refuses a prompt while its turn runs
         * (Codex) gets it the moment that turn ends (`#afterTurn`).
         */
        const text = approvalNoteText({ what: held.approval.question, outcome, option: chosen?.label ?? optionId, note });
        if (text !== null) this.deliver(text, 'you');
        this.#changed();
        return true;
    }

    /** Messages a provider refused mid-turn, sent in order as soon as a turn ends. */
    #afterTurn: Array<{ id: string; text: string; by: string | null; sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null; context: PromptContext }> = [];

    /**
     * A MESSAGE FOR THE AGENT THAT MUST ARRIVE: sent now when the provider takes it (Claude reads it at its next step);
     * held for the end of the turn when it refuses a prompt mid-turn (Codex), then sent in order. An approval's note
     * (item 16) — from the card here, or from a Genie approval answered on the Deck (main/feature-ipc.ts).
     */
    deliver(text: string, by: string | null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null = null, context: PromptContext = {}): void {
        if (!this.running) throw new Error('session is not running');
        if (this.#afterTurn.length === 0) {
            try {
                this.prompt(text, by, sent, context);
                return;
            } catch (error) {
                // Only a refusal DURING a turn can wait for its end. An idle driver failure must reach the caller.
                if (!this.#inTurn) throw error;
            }
        }
        const id = randomUUID();
        this.#afterTurn.push({ id, text, by, sent, context });
        const row = promptRow(text, by, sent, context);
        if (row.kind === 'message') void this.#emitRow({ ...row, pending: { id, content: sent?.content ?? null } });
        this.#changed();
    }

    /** A turn ended: hand off ONE queued message. Each subsequent turn drains the next. */
    #flushAfterTurn(): void {
        if (this.#afterTurn.length === 0 || !this.running || this.#approval !== null || this.#inTurn || this.#held) return;
        const next = this.#afterTurn[0]!;
        try {
            this.#send(next.text, next.by, next.sent, false, next.context);
        } catch (error) {
            this.#leaveQueuedAsDrafts();
            void this.#emitRow({ kind: 'notice', level: 'error', message: `Queued input was not delivered: ${error instanceof Error ? error.message : String(error)}` });
            return;
        }
        this.#afterTurn.shift();
        void this.#emitRow({ kind: 'prompt_delivery', id: next.id, status: 'sent' });
    }

    hasQueuedPrompt(id: string): boolean {
        return this.#afterTurn.some((p) => p.id === id);
    }

    discardPrompt(id: string): void {
        this.#afterTurn = this.#afterTurn.filter((p) => p.id !== id);
        void this.#emitRow({ kind: 'prompt_delivery', id, status: 'discarded' });
        this.#changed();
    }

    #leaveQueuedAsDrafts(): void {
        const waiting = this.#afterTurn;
        this.#afterTurn = [];
        for (const p of waiting) void this.#emitRow({ kind: 'prompt_delivery', id: p.id, status: 'undelivered' });
    }

    start(): void {
        if (this.#driver) return; // Reattach, never a second copy of the same agent.

        const { cwd, resumeSessionId, driverFactory } = this.#options;
        this.#driver = driverFactory({
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            events: {
                onUpdate: (update) => {
                    if (this.#ended) { this.#straggler(); return; }
                    void this.#ingest(update);
                },
                onProtocolError: (problem, detail) => {
                    // A stopped run's transport closing is the stop, not a fault of the agent.
                    if (this.#ended) return;
                    /*
                     * ONE thing lost, the session going on (prism-acp >= 0.13 says so: a frame it could not read, a
                     * temporary file it could not remove). A warning row in the stream, the state untouched. Taking it as
                     * the session's death painted a working agent `Broken` until its next turn (the owner, 2026-10-14).
                     */
                    if (detail?.recoverable === true) {
                        void this.#emitRow({ kind: 'notice', level: 'warning', message: problem });
                        return;
                    }
                    this.#turnState = 'failed';
                    this.#leaveQueuedAsDrafts();
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
                    if (this.#ended) return;
                    // Kept, never promoted to a fault. Plenty of providers log here normally,
                    // and a build that painted every one of them red would teach people to
                    // ignore red.
                    this.#stderr = [...this.#stderr, line].slice(-STDERR_KEPT);
                },
                onRequestPermission: (request) =>
                    new Promise<PermissionOutcomeLike>((resolve) => {
                        // Nobody will answer a stopped run's question: it is declined, and said once.
                        if (this.#ended) { this.#straggler(); resolve({ outcome: 'cancelled' }); return; }
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
                    if (this.#ended) { this.#straggler(); return; }
                    // Two turns are two replies even with nothing between them. Without this a
                    // whole conversation would accumulate into one unbounded row.
                    this.#closeMessage();
                    // An echo that never came is not still expected: a `you` row after this turn is a message, never
                    // the prompt's echo (see `#handle`).
                    this.#echo = null;
                    this.#echoSeen = '';

                    // A provider turn that ends while Genie holds none open ran SILENTLY — no reply, no tool — so nothing
                    // opened its marker: it is the oldest queued prompt's turn, marked now. Nothing queued: no prompt's
                    // turn, and it opens nothing, as before.
                    if (!this.#inTurn && this.#queued.length > 0) void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by: this.#queued.shift() ?? null });

                    this.#turns += 1;
                    this.#endedThisRun += 1;
                    this.#inTurn = false;

                    // A turn that did not finish cleanly is `failed`, not `idle`. Reporting
                    // idle would present a crashed turn as a completed one, which is the
                    // quietest way to lose work: the agent stops, the board says nothing is
                    // wrong, and nobody looks.
                    //
                    // A CANCELLED turn is the exception and is idle: cancelling is something
                    // the human did, and painting it as a fault blames the agent for being
                    // stopped.
                    const crashed = outcome.stopReason === null || outcome.isError;
                    // Ended by the limit: a reading said so during the turn, or the turn's own failure does (Tynn #791).
                    const readingSaidSo = this.#limitThisTurn;
                    const byLimit = crashed && (readingSaidSo || outcome.failure?.kind === 'rate_limit');
                    // Ended by the LOGIN (the owner, 2026-10-18): the provider says this account is not signed in.
                    // Ended by the ACCOUNT (the owner, 2026-10-21: a payment failure paused it): checked before the login,
                    // because prism-acp files `oauth_org_not_allowed` under `auth` and logging in does not fix it.
                    const paused = crashed && !byLimit ? accountPauseOf(outcome.failure) : null;
                    const bySignOut = crashed && !byLimit && paused === null && outcome.failure?.kind === 'auth';
                    // Overloaded (the provider's, and it passes): waited out and sent on again, until OVERLOAD_RETRY_MS runs out.
                    const byOverload = crashed && !byLimit && paused === null && !bySignOut && outcome.failure?.kind === 'overloaded' && this.#overloads < OVERLOAD_RETRY_MS.length;
                    this.#lastTurnEnd = byLimit || byOverload ? 'held' : bySignOut ? 'signed-out' : crashed ? 'failed' : outcome.stopReason === 'cancelled' ? 'stopped' : 'replied';
                    this.#limitThisTurn = false;
                    if (byLimit) {
                        // HELD, not failed (Tynn #793): the provider's own reading said its limit was reached. Nothing is
                        // Broken; the agent waits for the limit to reset and is resumed then.
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                        this.#held = true;
                        void this.#emitRow({ kind: 'notice', level: 'warning', message: "Paused: the provider's rate limit was reached. Genie resumes this agent when the limit resets." });
                        // A reading already told the gate; a failure alone has not, and it carries no reset of its own.
                        if (!readingSaidSo && outcome.failure) this.#options.onLimitBreach?.(outcome.failure.reason);
                    } else if (byOverload) {
                        const ms = OVERLOAD_RETRY_MS[this.#overloads]!;
                        this.#overloads += 1;
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                        this.#held = true;
                        void this.#emitRow({ kind: 'notice', level: 'warning', message: `The provider is overloaded (${outcome.failure?.reason ?? 'overloaded'}). Genie retries in ${Math.round(ms / 1000)} s (attempt ${this.#overloads} of ${OVERLOAD_RETRY_MS.length}); anything you send meanwhile goes then.` });
                        const later = this.#options.retryLater ?? ((wait: number, fire: () => void) => { const t = setTimeout(fire, wait); return () => clearTimeout(t); });
                        this.#overloadCancel = later(ms, () => { this.#overloadCancel = null; this.#resumeHeld(OVERLOAD_RESUME_PROMPT); });
                    } else if (paused !== null) {
                        // ACCOUNT PAUSED, not Broken and not Signed out: the provider refused the account itself. Said in
                        // words with what to do; main alerts once per login and `Try again` brings every agent on it back.
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                        this.#accountPaused = paused;
                        void this.#emitRow({ kind: 'notice', level: 'warning', message: `Account paused: ${paused.words} (${paused.reason}). Check the subscription and its billing with the provider, then use "Try again".` });
                    } else if (bySignOut) {
                        // SIGNED OUT, not Broken: nothing about the agent is wrong; its provider's login is. The header and
                        // the chat offer `Log in`, and a successful login brings it back (main/login-host.ts).
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                        this.#signedOut = true;
                        void this.#emitRow({ kind: 'notice', level: 'warning', message: `Signed out: the provider refused this login (${outcome.failure?.reason ?? 'auth'}). Use "Log in" above; Genie brings this agent back once you are signed in.` });
                    } else if (crashed) {
                        this.#turnState = 'failed';
                        // The provider's own reason (`authentication_failed`, `overloaded`…) says more than the CLI's generic one.
                        this.#failure = outcome.failure?.reason ?? outcome.raw;
                        this.#failedAt = this.#now();
                    } else {
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                        this.#overloads = 0;
                        // A turn that went through: whatever login it ran on is signed in, and its account is in order.
                        this.#signedOut = false;
                        this.#accountPaused = null;
                    }
                    // A STOPPED TURN SAYS SO, in the ledger and the chat: `Stopped by you`. ACP reports a cancelled turn
                    // and nothing more, so without this row a stopped turn read exactly like one that finished — the
                    // reply simply ending mid-way. Who stopped it is whoever asked (`cancel`), and nobody when no one
                    // here did.
                    const stopper = this.#stopAskedBy;
                    this.#stopAskedBy = null;
                    if (outcome.stopReason === 'cancelled' && !outcome.isError) void this.#emitRow({ kind: 'stopped', n: Math.max(this.#marked, this.#turns), by: stopper });
                    // A TURN THAT FINISHED SAYS SO too (beta.33 item 10): the lanes' "finished" is this row, as it happens —
                    // never the agent's last handoff, which a session answering in chat never files.
                    if (this.#lastTurnEnd === 'replied') void this.#emitRow({ kind: 'finished', n: Math.max(this.#marked, this.#turns) });
                    // A QUEUED PROMPT IS NOT ASSUMED TO BECOME A TURN (the owner, 2026-10-20: idle agents not woken by
                    // mail). Claude Code FOLDS a prompt sent mid-turn into the running turn; opening its turn here left a
                    // phantom one that never ended — moic `working` for 36 minutes while idle, so no inbox notice and the
                    // owner's next message queued behind it. The agent is idle now; a turn opens when the PROVIDER starts
                    // one (its first activity, credited to the oldest queued sender) or ends one silently (above). After a
                    // crashed turn nothing is assumed to run: the queue is dropped and the failure stands.
                    if (crashed) this.#queued = [];
                    // EXCEPT after a stop: there is no running turn to fold into, and Claude runs the queued prompt as its
                    // own turn after the interrupt (measured, test/stop-cancels-turn.test.ts), so that turn opens now.
                    else if (outcome.stopReason === 'cancelled' && this.#queued.length > 0) {
                        void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by: this.#queued.shift() ?? null });
                        this.#inTurn = true;
                        this.#turnState = 'working';
                    }
                    // A note the provider refused mid-turn (an approval's, item 16) goes now, as its own turn.
                    if (crashed) this.#leaveQueuedAsDrafts();
                    else if (!this.#inTurn) this.#flushAfterTurn();
                    // Announced AFTER the state is set: announced before, every listener read `working` and nothing
                    // announced again — the doctor channel waited out its timeout and the board kept a finished turn as
                    // Working (found in the first doctor trial, 2026-10-13).
                    this.#changed();
                },
                onExit: (code, signal) => {
                    this.#leaveQueuedAsDrafts();
                    // A retry waiting out an overload has nobody to send to now.
                    this.#overloadCancel?.();
                    this.#overloadCancel = null;
                    // Persist whatever of the last reply arrived. A provider dying mid-sentence
                    // should cost the rest of the sentence, not the part it already said.
                    this.#closeMessage();

                    this.#alive = false;
                    this.#exited = true;
                    this.#inTurn = false;
                    this.#queued = [];
                    this.#stopAskedBy = null;
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
                     * **And written down** (2026-10-22): the failure and the stderr above live in THIS session's memory,
                     * and a restart replaces the session — a Codex agent's graceful restart died with "a codex app-server
                     * error" and its words were gone before anyone read them. A failed run leaves one `error` notice in
                     * the ledger, which outlives the run: the reason, the exit, and the last stderr lines (where a
                     * provider explains itself), capped so a chatty one cannot flood the thread. A clean exit writes
                     * nothing (test/session.test.ts holds both).
                     */
                    if (this.#failure) void this.#emitRow({ kind: 'notice', level: 'error', message: failedRunText(this.#failure, code, signal, this.#stderr) });
                    const waiters = this.#exitWaiters;
                    this.#exitWaiters = [];
                    for (const w of waiters) w();

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
        const before = tree.snapshot();
        this.#driver.start();
        const after = before === null ? null : tree.snapshot();
        if (before !== null && after !== null) {
            this.#roots = newChildrenOf(before, after, process.pid);
            this.#members = subtreeOf(after, this.#roots);
            this.#options.onSpawned?.(this.#members);
        }
        this.#alive = true;
        // READY, when the driver declares when (see `SessionDriver.ready`): announced, so whatever waits for it (the inbox
        // push) is told without polling. A rejection is still the end of starting — the failure itself arrives through
        // the driver's own events (`onProtocolError`, `onExit`), which is where it is reported.
        const ready = this.#driver.ready;
        if (ready !== undefined) {
            this.#starting = true;
            const done = (): void => { this.#starting = false; this.#changed(); };
            ready.then(done, done);
        }
        // The turns continue from the record's last, so a restarted agent's next turn is not "Turn 1" again beside the
        // turns it already had.
        // Known at start (the record's last turn): nothing to count. Otherwise counted from the record, asynchronously.
        if (this.#options.turnsBefore === undefined) {
            const startedAt = Date.now();
            void readHistory(this.#options.store, this.agentId, { before: startedAt, ...(this.#options.runId !== undefined ? { run: this.#options.runId } : {}) })
                .then((h) => { const recorded = lastTurnOf(h.rows); this.#turns += recorded; this.#marked += recorded; })
                .catch(() => { /* no record yet: turns start at 1 */ });
        }
        this.#turnState = 'working';
    }

    /**
     * `by` is who started the turn when the caller knows (`you` from the composer, `genie` for a reminder or a
     * handoff ask, a peer's name) — written into the ledger as the turn's marker, and `null` when nobody said.
     */
    prompt(text: string, by: string | null = null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null = null, context: PromptContext = {}): void {
        if (!this.#driver) throw new Error('session is not started');
        if (this.#held) {
            // Held for the limit: recorded now, as it was sent; handed to the provider when the limit resets.
            void this.#emitRow(promptRow(text, by, sent, context));
            this.#heldPrompts.push({ text, by, sent });
            this.#changed();
            return;
        }
        this.#send(text, by, sent, true, context);
    }

    /** Hand a prompt to the provider and open (or queue) its turn; `record` writes its message row too. */
    #send(text: string, by: string | null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null, record = false, context: PromptContext = {}): void {
        if (!this.#driver) throw new Error('session is not started');
        // The provider takes it FIRST: a prompt it refuses (Codex while a turn runs, a driver that throws) writes nothing
        // and leaves the session as it was — it used to leave a turn marker and your message for a turn that never ran,
        // "in a turn" with nothing running (Working, and a clock that never moved), and the next prompt reused the number.
        // The hand-off is synchronous, so the marker below still lands before the provider's first frame.
        this.#driver.prompt(sent ? sent.content : text);
        // The marker lands BEFORE the provider's first frame, so every row that follows is inside this turn — unless a
        // turn is running, when this prompt waits for its own (see `#queued`).
        if (this.#inTurn) this.#queued.push(by);
        else {
            // Whatever the queue still holds was folded into an earlier turn (no turn of its own came): not ahead of this.
            this.#queued = [];
            void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by });
            this.#inTurn = true;
            this.#limitThisTurn = false;
        }
        // YOUR MESSAGE, recorded as it is sent. Claude does not echo a prompt back, so waiting for the wire's
        // `user_message_chunk` left the owner's own words out of the thread. A peer's prompt is that peer's message.
        if (record) void this.#emitRow(promptRow(text, by, sent, context));
        // A provider that DOES echo it is not recorded twice (see `#handle`).
        this.#echo = text;
        this.#echoSeen = '';
        this.#turnState = 'working';
    }

    /**
     * END THE RUN, AND PROVE IT ENDED (hosting plan 1.3; the owner, 2026-10-20: "agents get duplicated").
     *
     * 1. **It stops listening at once** (`#ended`, plan 1.4): the run is over for Genie the moment Stop is asked.
     * 2. **Stdin first, with a grace** (`graceMs`, only for a driver that can close it): Claude ends on its own and
     *    flushes the conversation a graceful restart resumes. The previous build never called prism-acp's `endInput()`.
     *    A driver with prism-acp 0.21's `stop()` does this itself and ends its supervised tree; it is called once.
     * 3. **Then the kill and the reap.** On Windows the driver's kill reaches only the `cmd.exe` prism-acp spawns
     *    through; `claude.exe` and everything under it would live on with a dead parent. So the run's tree is read
     *    BEFORE the kill — the kill is what orphans — from this run's own roots, and every process of it is ended.
     * 4. **Then a fresh reading verifies it**: every process this run was seen to own is gone. One that will not go
     *    makes the verdict UNVERIFIED, naming it — never a success. A stop that could not read the machine says so.
     *
     * With no grace (quit, upgrade) steps 1-3 and the first verification run before this returns, synchronously: a
     * quit that proceeds right after it has already killed the tree.
     */
    stop(signal: NodeJS.Signals = 'SIGTERM', options: { graceMs?: number } = {}): Promise<StopVerdict> {
        if (this.#stopping) return this.#stopping;
        this.#ended = true;
        this.#leaveQueuedAsDrafts();

        // A promise nobody will ever resolve is a provider process waiting forever. `stop` means stop, and that has to
        // include the things stop is waiting ON.
        const abandoned = this.#approval;
        if (abandoned) void this.#emitRow({ kind: 'approval', question: abandoned.approval.question, tool: abandoned.approval.tool ?? null, outcome: 'cancelled', optionId: null });
        abandoned?.resolve({ outcome: 'cancelled' });
        this.#approval = null;
        this.#parkedAt = null;
        this.#turnState = 'stopped';
        this.#inTurn = false;
        this.#queued = [];
        this.#stopAskedBy = null;

        const tree = this.#options.processTree ?? systemProcessTree;
        const driver = this.#driver;
        const graceMs = options.graceMs ?? 0;
        if (graceMs > 0 && driver?.stop && this.#alive && !this.#exited) {
            // PRISM-ACP 0.21.1 OWNS THE TREE: its stop closes stdin, waits the grace, ends the supervised tree (a Job Object
            // on Windows) and reports. Genie's reading then verifies it as before — and reaps anything it still finds.
            const early = this.#roots && this.#roots.length > 0 ? tree.snapshot() : null;
            if (early && this.#roots) this.#members = unionOf(this.#members, subtreeOf(early, this.#roots));
            let ended: Promise<unknown>;
            try { ended = Promise.resolve(driver.stop({ graceMs })); } catch (error) { ended = Promise.reject(error); }
            this.#stopping = ended.catch(() => undefined).then(() => this.#endTree(tree, signal));
        } else if (graceMs > 0 && driver?.endInput && this.#alive && !this.#exited) {
            // The tree BEFORE stdin closes: a provider that then ends on its own (on Windows) orphans its children, and
            // a reading after its exit could no longer reach them from the roots.
            const early = this.#roots && this.#roots.length > 0 ? tree.snapshot() : null;
            if (early && this.#roots) this.#members = unionOf(this.#members, subtreeOf(early, this.#roots));
            try { driver.endInput(); } catch { /* a stdin already closed: the kill below ends it */ }
            this.#stopping = this.#exitWithin(graceMs).then(() => this.#endTree(tree, signal));
        } else {
            this.#stopping = this.#endTree(tree, signal);
        }
        this.#alive = false;
        void this.#stopping.then((v) => { this.#verdict = v; });
        return this.#stopping;
    }

    /** The stop's verdict once it is known; `null` while it is still running (or before any stop). */
    get stopVerdict(): StopVerdict | null {
        return this.#verdict;
    }

    /**
     * Resolves when the provider exits, or after `ms` — whichever is first. What a quit waits on (`SessionHost.drained`):
     * a killed provider's EXIT is what queues the reply it closes, and it arrives after `stop()` has returned.
     */
    exitedWithin(ms: number): Promise<void> {
        return this.#exitWithin(ms);
    }

    /** Resolves when the provider exits, or after `ms` — whichever is first. */
    #exitWithin(ms: number): Promise<void> {
        if (this.#exited) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            function done(): void { clearTimeout(timer); resolve(); }
            this.#exitWaiters.push(done);
        });
    }

    /** Kill, reap, verify. Synchronous up to the first verification; retries (bounded) only for a survivor. */
    #endTree(tree: ProcessTree, signal: NodeJS.Signals): Promise<StopVerdict> {
        const roots = this.#roots;
        const before = roots && roots.length > 0 ? tree.snapshot() : null;
        if (before && roots) this.#members = unionOf(this.#members, subtreeOf(before, roots));
        // Everything of this run that is still running now: the roots' tree as it is, and any member a provider's own
        // exit already orphaned (still the SAME process: pid, start time and name).
        const targets = before ? stillRunning(this.#members, before) : [];

        this.#driver?.kill(signal);
        const reap = tree.killTree(targets, before ?? []);

        const settled = (v: StopVerdict): Promise<StopVerdict> => { this.#verdict = v; return Promise.resolve(v); };
        if (roots === null) {
            // Nothing was recorded at start (the machine could not be read): nothing to verify against.
            return settled({ verified: false, reason: 'Genie could not read this agent’s processes when it started, so it cannot verify they ended.', survivors: [] });
        }
        if (roots.length > 0 && before === null) {
            return settled({ verified: false, reason: 'Genie could not read the machine’s processes to end this agent’s tree.', survivors: [] });
        }
        const check = (): StopVerdict | null => {
            if (this.#members.length === 0) return { verified: true, ended: 0 };
            const now = tree.snapshot();
            if (now === null) return { verified: false, reason: 'Genie could not read the machine’s processes to verify this agent ended.', survivors: [] };
            const survivors = stillRunning(this.#members, now);
            if (survivors.length === 0) return { verified: true, ended: this.#members.length };
            if (reap.refused) return { verified: false, reason: reap.reason ?? 'The reap was refused.', survivors };
            return null;
        };
        const first = check();
        if (first) return settled(first);
        // A process just killed can take a moment to leave the table. Kill what is left again, look again, a few times.
        return (async (): Promise<StopVerdict> => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                await new Promise((r) => setTimeout(r, 250));
                const now = tree.snapshot();
                if (now === null) break;
                const left = stillRunning(this.#members, now);
                if (left.length === 0) return { verified: true, ended: this.#members.length };
                tree.killTree(left, now);
            }
            const now = tree.snapshot();
            const survivors = now ? stillRunning(this.#members, now) : this.#members;
            if (now && survivors.length === 0) return { verified: true, ended: this.#members.length };
            return { verified: false, reason: `Still running after the stop: ${describeProcesses(survivors)}.`, survivors };
        })();
    }

    /** Output (or a question) from this run after it was stopped: dropped, and said once. */
    #straggler(): void {
        if (this.#stragglerNoted) return;
        this.#stragglerNoted = true;
        void this.#emitRow({ kind: 'notice', level: 'warning', message: 'This agent’s previous run was still producing output after it was stopped. That output was not recorded, and the run was ended.' });
        this.#options.onStraggler?.();
    }

    /** Whether this session's driver can end a turn and keep the session (it has prism-acp's `cancel`). */
    get canCancelTurn(): boolean {
        return typeof this.#driver?.cancel === 'function';
    }

    /**
     * STOP THE CURRENT TURN; KEEP THE AGENT (prism-acp's `cancel`: Claude's interrupt control request, Codex's
     * `turn/interrupt`). The composer's and the Agent view's `Stop this turn` land here. Ending the whole session is
     * `stop()`, a separate and explicit action ("Stop agent") — the turn's Stop used to be that, so interrupting the
     * agent killed it (the owner, 2026-10-15).
     *
     * - **The state is NOT set here.** The turn is over when the provider says so: `onTurnEnd` with `cancelled`, which
     *   is idle — never failed — and records `Stopped by <by>`. Painting idle on the ask would claim what the protocol
     *   has not reported.
     * - **Queued prompts are KEPT.** Measured on Claude Code (prism-acp-ts#17, 2026-10-15): a message queued at the
     *   interrupt still runs afterwards. So the next queued prompt's turn starts when the cancelled one ends, numbered
     *   and attributed as ever. Codex queues nothing (one prompt in flight).
     * - **A parked approval is answered `cancelled`**, ACP's rule for a cancelled turn: an unanswered request would
     *   outlive the turn and park the provider.
     * - **A driver that cannot cancel is never killed instead**, and neither is one that refuses the interrupt: the
     *   stream says so, the turn runs on, and Stop agent remains the way to end it.
     */
    /**
     * A PLAN THE AGENT REPORTED THROUGH GENIE'S `plan` TOOL (the owner, 2026-10-20: the Active Plan column had no way to
     * be filled — the Claude Code Genie runs reports no plan of its own). Written as the SAME `plan` row a provider's plan
     * update makes, so the column, the Stream and the thread show it exactly as they would the provider's.
     */
    reportPlan(entries: readonly { content: string; status: string }[]): void {
        void this.#emitRow({ kind: 'plan', entries: entries.map((e) => ({ content: e.content, status: e.status })) });
        this.#changed();
    }

    /** A warning Genie says in this agent's chat (the plan keepalive's stop, core/plan-keepalive.ts). Not a prompt. */
    notice(message: string): void {
        void this.#emitRow({ kind: 'notice', level: 'warning', message });
        this.#changed();
    }

    /** The driver's model state, or `null` when nothing is running or the driver cannot say (`SessionDriver.modelState`). */
    modelState(): Promise<SessionModelState> | null {
        const driver = this.#driver;
        if (!driver || this.#exited || !this.#alive || typeof driver.modelState !== 'function') return null;
        return driver.modelState();
    }

    /** Switch the running session's model, or `null` when nothing is running or the driver cannot (`SessionDriver.setModel`). */
    switchModel(modelId: string): Promise<void> | null {
        const driver = this.#driver;
        if (!driver || this.#exited || !this.#alive || typeof driver.setModel !== 'function') return null;
        return driver.setModel(modelId);
    }

    cancel(by: string | null = 'you'): CancelOutcome {
        const driver = this.#driver;
        if (!driver || this.#exited || !this.#alive) return { ok: false, reason: 'not-running' };
        if (!this.#inTurn) return { ok: false, reason: 'no-turn' };
        if (typeof driver.cancel !== 'function') {
            void this.#emitRow({ kind: 'notice', level: 'warning', message: 'This agent cannot stop a turn on its own. The turn is still running; Stop agent ends the session.' });
            this.#changed();
            return { ok: false, reason: 'unsupported' };
        }

        this.#stopAskedBy = by;
        const refused = (cause: unknown): void => {
            this.#stopAskedBy = null;
            const why = cause instanceof Error ? cause.message : String(cause);
            void this.#emitRow({ kind: 'notice', level: 'warning', message: `The turn could not be stopped: ${why}. It is still running; Stop agent ends the session.` });
            this.#changed();
        };
        try {
            void Promise.resolve(driver.cancel()).catch(refused);
        } catch (cause) {
            refused(cause);
            return { ok: false, reason: 'refused' };
        }

        const abandoned = this.#approval;
        if (abandoned) void this.#emitRow({ kind: 'approval', question: abandoned.approval.question, tool: abandoned.approval.tool ?? null, outcome: 'cancelled', optionId: null });
        abandoned?.resolve({ outcome: 'cancelled' });
        this.#approval = null;
        this.#parkedAt = null;
        this.#changed();
        return { ok: true };
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
                await thread.record([persistable(open.event, this.#options.runId)]);
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

        // THE PROVIDER'S RATE LIMIT (Tynn #793), read before anything awaits: the gate is told every reading, and a
        // non-allowed one in a running turn marks that turn as ended by the limit if it then ends in error.
        const meta = update['_meta'];
        if (typeof meta === 'object' && meta !== null && RATE_LIMIT_META in meta) {
            const readings = limitReadingsFromMeta((meta as Record<string, unknown>)[RATE_LIMIT_META]);
            if (readings.length > 0) {
                const notice = update['notice'];
                const said = typeof notice === 'object' && notice !== null ? (notice as Record<string, unknown>)['message'] : null;
                this.#options.onRateLimit?.(readings, typeof said === 'string' ? said : null);
                if (this.#inTurn && readings.some((r) => r.status !== 'allowed')) this.#limitThisTurn = true;
            }
        }

        // The agent's commands, skills and plugins (core/provider-commands.ts): state, not a ledger row — and checked
        // before the early return below for the same reason as the session id.
        const extensions = extensionsFrom(update);
        if (extensions) {
            this.#extensions = extensions;
            this.#changed();
        }

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
        // The provider's echo of the prompt just sent — identical — is already in the thread (`prompt`). Only a MESSAGE
        // ends the watch: the agent's or a peer's reply, or a user message that is not that echo (history replayed on
        // resume), which is kept. Everything else passes through with the watch still open — Codex sends debug notices
        // (`thread/status/changed has no other ACP mapping`) BEFORE its echo, which arrives seconds later; when the first
        // notice ended the watch, the echo was recorded as a second `you` row and the owner saw every message twice
        // (2026-10-22). Claude never echoes, which is why only Codex showed it. The turn ending ends it too (`onTurnEnd`).
        if (this.#echo !== null && event.kind === 'message') {
            if (event.speaker === 'you' && this.#echo.startsWith(this.#echoSeen + event.text)) {
                this.#echoSeen += event.text;
                if (this.#echoSeen === this.#echo) { this.#echo = null; this.#echoSeen = ''; }
                return;
            }
            this.#echo = null;
            this.#echoSeen = '';
        }

        // A TURN THE AGENT STARTED ITSELF. After a turn has ended, Claude Code can begin another with no prompt from Genie
        // (a background task finished, a subagent reported). Its activity — a reply, a thought, a tool call — opens a
        // turn: a marker (nobody prompted it, so `by: null`) and `working` until it ends. Without this it ran under
        // "Idle", and a quit, which cancels only the turns it believes are running, killed it mid-flight. What trails a
        // turn's end (usage, debug notices) is not activity and opens nothing.
        if (this.#turnState === 'idle' && (event.kind === 'think' || event.kind === 'tool' || (event.kind === 'message' && event.speaker === 'agent'))) {
            // A prompt queued while the last turn ran is credited to this one (it ran as its own turn); none = nobody's.
            void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by: this.#queued.shift() ?? null });
            this.#inTurn = true;
            this.#turnState = 'working';
            this.#changed();
        }

        // Claude reports a running token estimate BETWEEN a thought's deltas (prism-acp: a debug notice). It is part of
        // the thought, not something after it: closing the thought here split one thought into a row per delta.
        if (event.kind === 'notice' && event.level === 'debug' && typeof event.estimate === 'number') {
            const open = this.#openMessage;
            if (open && open.event.kind === 'think') {
                open.event = { ...open.event, estimate: event.estimate };
                this.#options.onEvent?.(open.event, { replacesLast: true });
                return;
            }
        }

        if (event.kind === 'think') {
            const open = this.#openMessage;
            if (open && open.event.kind === 'think') {
                // The provider's estimate is cumulative for the thought: the newest one stands; a chunk without one keeps it.
                open.event = { ...open.event, text: open.event.text + event.text, estimate: event.estimate ?? open.event.estimate ?? null };
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
        const written = this.#emitRow(event);
        // REFUSED FOR WANT OF /design-login (#1081): said ONCE per login, after the refused call, however many calls fail.
        if (!this.#designLogin && designLoginRefused(event)) {
            this.#designLogin = true;
            void this.#emitRow({ kind: 'notice', level: 'warning', message: 'Claude Design needs its login on this machine, which an agent session cannot run. Use "Log in to Claude Design" above; Genie tells this agent to retry once it has run.' });
            this.#changed();
        }
        await written;
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

        // ON THE SAME CHAIN as the message writes: waiting for the chain and then writing outside it let two rows
        // emitted together (a turn marker and your message) reach the thread in either order.
        const write = async (): Promise<void> => {
            try {
                const thread = openAgentThread(this.#options.store, this.agentId);
                await thread.record([persistable(event, this.#options.runId)]);
            } catch {
                // A storage fault must not take the turn down with it — but it must also not
                // vanish. Counted, so a surface can say "this conversation is not being saved"
                // instead of quietly holding a partial history.
                this.#unpersisted += 1;
            }
        };
        this.#writes = this.#writes.then(write, write);
        await this.#writes;
    }
}

/** What a prompt's ledger row carries beyond its text: a Genie notice's mail (beta.33 item 18). */
export interface PromptContext {
    readonly mail?: readonly NoticeMail[] | undefined;
}

/**
 * A prompt's own message row: yours (`you`, or nobody said), or the sender's as a peer — with its files, and, for a
 * Genie notice, the mail it told about. Absent fields are left off, never written empty.
 */
function promptRow(text: string, by: string | null, sent: { attachments: readonly string[] } | null, context: PromptContext): StreamEvent {
    const attachments = sent && sent.attachments.length > 0 ? { attachments: sent.attachments } : {};
    const mail = context.mail && context.mail.length > 0 ? { mail: context.mail } : {};
    return by === null || by === 'you'
        ? { kind: 'message', speaker: 'you', peerName: null, text, ...attachments }
        : { kind: 'message', speaker: 'peer', peerName: by, text, ...attachments, ...mail };
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
function persistable(event: StreamEvent, runId: string | undefined): JsonObject {
    const run = runId !== undefined ? { [RUN_FIELD]: runId } : {};
    try {
        return { ...(JSON.parse(JSON.stringify(event)) as JsonObject), ...run };
    } catch {
        // A cyclic `rawInput` is the realistic case. Keep the row and its kind — losing
        // payload is survivable, losing the fact that the event happened is not.
        return { kind: event.kind, unserialisable: true, ...run } as JsonObject;
    }
}
