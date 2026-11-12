import type { SessionModelState } from '@particle-academy/prism-acp';
import type { JsonObject, SessionStore } from '@particle-academy/prism-harness';
import type { CommandRunRef } from './command-run.js';
import { openAgentThread, readHistory, RUN_FIELD, ThreadStore } from './thread-store.js';
import { boundToolEvent, utf8Bytes } from './tool-row-bound.js';
import { approvalFrom, type Approval } from './approval.js';
import { approvalNoteText } from './approval-note.js';
import { REPLAY_META, REPLAY_SUMMARY_META, toStreamEvent, type AttachmentRef, type NoticeMail, type StreamEvent } from './stream-event.js';
import { extensionsFrom, type ProviderExtensions } from './provider-commands.js';
import { threadKeyFor, type AgentId } from './identity.js';
import type { PromptBlock } from './prompt-content.js';
import { carriedLabel, type CarryOver } from './carry-over.js';
import { describeProcesses, newChildrenOf, stillRunning, subtreeOf, systemProcessTree, unionOf, type ProcessInfo, type ProcessTree, type ReapResult, startTimeUnknown } from './process-tree.js';
import { limitReadingsFromMeta, type LimitReading } from './rate-limit-gate.js';
import { mcpReportsFromMeta, type McpServerReport } from './mcp-missing.js';
import { RATE_LIMIT_META, headroomFromMeta, rateLimitWarning, type Headroom } from './headroom.js';
import { accountPauseOf, type AccountPause } from './account-pause.js';
import { designLoginRefused } from './design-login.js';
import { randomUUID } from 'node:crypto';
import { SLEEPING_AFTER_IDLE_MS } from './agent-status.js';
import { redockReorientation } from './redock.js';
import { providerProblemWords } from './claude-cli-version.js';

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
    /** Deferred drivers surround the actual synchronous spawn with the session's ownership snapshot. */
    startTracked?(aroundSpawn: (spawn: () => void) => void): void;
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
    /**
     * READ THE PROVIDER'S RATE LIMITS NOW, WITH NO TURN — prism-acp 0.26.0's `CodexDriver.readRateLimits()` (genie#1195).
     * The reading arrives through the same `_meta` path as the start-up read (`onRateLimit`); it never rejects — a failed
     * read is reported on the session. Optional: Claude's driver has none (its limits come with its own events).
     */
    readRateLimits?(): Promise<void>;
    /**
     * STEER A RUNNING TURN — prism-acp 0.38.0's `CodexDriver.steer` (Tynn #440): input added to the turn in flight, so
     * mail reaches a busy Codex agent at its next step, as it reaches Claude. `supported` needs Codex >= 0.163; without
     * it (or without these members: Claude, a fake, an older prism) a mid-turn prompt is held for the turn's end.
     * Acceptance is not observation: a record reaches `observed` (`onSteerUpdate`, `steerState`) when the provider shows
     * the input in the turn. Steer state is per driver process; it does not survive a restart.
     */
    readonly steeringState?: { readonly supported: boolean };
    steer?(content: readonly PromptBlock[], options: { clientId: string }): Promise<SteerAcceptanceLike>;
    steerState?(clientId: string): SteerRecordLike | { readonly kind: 'not_known' };
    acknowledgeSteer?(clientId: string): boolean;
    /**
     * RUN ONE OF THE COMMANDS THE PROVIDER ADVERTISED — prism-acp 0.39.0's `CodexDriver.runCommand(name)` (Tynn #440):
     * `compact`, `review`. Resolves on acceptance; the command's completion is the turn's end (`onTurnEnd`). Rejects
     * with `CommandUnsupported` (`code: 'command_unsupported'`, a fixed `reason`) when it will not run. Absent (Claude):
     * a command is the prompt text, and the CLI runs it.
     */
    runCommand?(name: string): Promise<void>;
}

/** prism-acp 0.38.0's `SteerAcceptance`: the native reply to one steer. */
export type SteerAcceptanceLike = { readonly outcome: 'accepted' | 'not_delivered' | 'unknown'; readonly steerId: string };

/** prism-acp 0.38.0's `SteerRecord` (and `SteerUpdate`): what became of one steer, as far as the provider has shown. */
export interface SteerRecordLike {
    readonly steerId: string;
    readonly kind: string;
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
    /** What the supervisor found when a stop settled (prism-acp): `stop` drops Genie's sweep only for a verified empty tree. */
    onStopVerdict?: (verdict: NativeStopVerdict) => void;
    /** A steer's record changed (prism-acp 0.38.0, Codex): accepted, observed, ended unobserved, not delivered, unknown. */
    onSteerUpdate?: (update: SteerRecordLike) => void;
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
 * WHY A TURN IS CANCELLED (Tynn #672 part 3). `stop`: the person's "Stop this turn"; the session then waits for them
 * (genie#1565, `#stoppedByYou`). `interrupt`: "Interrupt and send", which cancels the turn so the person's message, already
 * handed over, runs next. That message is the next work, so nothing latches.
 */
export type CancelIntent = 'stop' | 'interrupt';

/** An intent from outside (IPC, the remote protocol, the engine): only `interrupt` is an interrupt; anything else is a Stop. */
export function cancelIntent(raw: unknown): CancelIntent {
    return raw === 'interrupt' ? 'interrupt' : 'stop';
}

/**
 * How a stop ended (`AgentSession.stop`). `verified` only when a fresh reading shows every process the run was seen to
 * own is gone. Unverified says why, and names what is still running (`survivors`, empty when it could not look).
 */
/** What prism-acp's supervisor reports of a stop: whether nothing of the tree is left, and whether it counted that itself. */
export interface NativeStopVerdict { readonly graceful: boolean; readonly empty: boolean; readonly survivors: number | null; readonly verified: boolean }

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

/**
 * CLAUDE'S CANCEL STATE UNCERTAIN (prism-acp 0.37.0): its cancel receipt was missing (30 s) or did not account for the
 * prompts in flight, so prism-acp ended them all cancelled (raw `cancel accounting mismatch`), stopped the CLI and said
 * this fixed reason through `onProtocolError`; that driver's `prompt()` throws `ClaudeCancelStateError` with this code
 * from then on. Matched here by value so core/ stays free of prism-acp at runtime; test/prism-acp-version.test.ts holds
 * them to the installed package's own error.
 */
export const CANCEL_STATE_UNCERTAIN = 'cancel state uncertain; driver stopped';
/** What the chat says when an interrupt the provider never confirmed restarted the agent for its queue (Tynn #702). */
export const RESTARTED_FOR_QUEUE = 'The provider did not confirm the interrupt in time, so Genie restarted the agent on the same conversation; your messages are sent now.';
export const CANCEL_STATE_UNCERTAIN_CODE = 'claude_cancel_state_uncertain';

/** A provider gets this long to confirm the turn ended; a receipt alone is not a stopped turn (Tynn #661). */
export const TURN_CANCEL_WAIT_MS = 2_000;

/**
 * COOLING (the owner, 2026-11-01): "a state they enter right after finishing a turn (coming out of the work state).
 * Instead of immediately marking them as idle, they are "Cooling" down for 15 seconds then become Idle. This way I can
 * sort By status and agents that are in between turns aren't making the whole list jump around."
 *
 * How long a turn that ended cleanly reads `Cooling` before `Idle`. Fixed, not a setting. DISPLAY ONLY: `turnState` is
 * `idle` throughout, so nothing that decides whether to prompt (the inbox push, a flow, the person's message, a setting
 * applied after a turn) waits for it.
 */
export const COOLING_MS = 15_000;

export interface AgentSessionOptions {
    agentId: AgentId;
    cwd: string;
    /**
     * Told to continue when its provider's rate limit resets (LIMIT_RESUME_PROMPT), if the limit cut its turn off. `false`
     * for the OS agent (Tynn #543, the owner: it "is mostly used for diagnostics and system setup, it doesn't do work, so
     * it does not need to be nudged"). Default true.
     */
    limitNudge?: boolean;
    store: SessionStore;
    driverFactory: SessionDriverFactory;
    /** Resume this provider-side conversation instead of starting a fresh one. */
    resumeSessionId?: string | null;
    /**
     * THE CONVERSATION A PROVIDER SWITCH CARRIES (Tynn story #380, core/carry-over.ts): attached ONCE, above the words of
     * the next prompt that goes; the chat marks that turn with a `notice` row carrying the exact text sent, and the
     * person's message row stays their words alone. A send the provider refuses, or a turn that does not reply (failed,
     * stopped, held), keeps it for the next prompt; a turn that replied calls `onCarryOverSent`.
     */
    carryOver?: CarryOver | null;
    onCarryOverSent?: () => void;
    /** Independent of provider carry-over and held trust words; consumed only by an accepted first prompt. */
    redockAt?: string;
    onRedockSent?: (at: string) => void;
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
     * HOW A PERMISSION REQUEST IS ANSWERED, decided per request (genie#1188): `ask` parks it for the person, as every
     * request was before; `allow` and `deny` answer it at once, with the request's own option of that ACP kind
     * (`allow_once` / `reject_once`) — never one guessed from a label. Read at the moment the provider asks, so a
     * change to what decides it applies to the next request with nothing restarted. Absent = `ask`.
     */
    permissionDecision?: (request: PermissionRequestLike) => 'allow' | 'deny' | 'ask';
    /** Why a request it parks still asks although the agent is Autonomous (Tynn #439), read as it parks; drawn on the card. */
    askWhy?: () => string | null;
    /**
     * Whether this run may be handed work now, asked at each hand-over. False = it waits, as it does on a limit, and a run
     * that ends leaves it owed, so the next one gets it. Absent = always.
     */
    mayTakeWork?: () => boolean;
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
    /** The provider's headroom, as a frame reports it — for the Dashboard header (main buffers it per provider). */
    onHeadroom?: (headroom: Headroom) => void;
    /** Each MCP server's state as the provider reports it (prism-acp 0.27.0, genie#1202): what a missing server is told by. */
    onMcpServers?: (reports: readonly McpServerReport[]) => void;
    /**
     * An interrupt the provider never confirmed ended this run (Tynn #702): what waited is kept (`carried`), and the host
     * starts the agent again on the same conversation and sends it. Absent = nothing restarts it on its own.
     */
    onRestartForQueue?: () => void;
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
    /** The driver's declared `ready` settled: `true` up, `false` failed (Tynn #558). Never called for a driver with no `ready`. */
    onStartSettled?: (ok: boolean) => void;
    /** The machine could not be read after a spawn, twice: these pids are recorded with no start time. */
    onReadingFailed?: (pids: readonly number[]) => void;
    /** Output arrived from this run after it was stopped (hosting plan 1.4). Said once per run. */
    onStraggler?: () => void;
    /** Genie's clock, for the stamps below (when an approval parked, when a failure was recorded). Injected so a host's clock reaches them. */
    clock?: () => number;
    /** Run `fire` after `ms`; answers a cancel (an overload's retry, the Cooling wait). Injected so a test can fire it; default `setTimeout`. */
    retryLater?: (ms: number, fire: () => void) => () => void;
}

export class AgentSession {
    readonly agentId: AgentId;

    #driver: SessionDriver | null = null;
    #held = false;
    /**
     * The limit CUT OFF this agent's last turn (it ended on the limit), and it has not been told to continue since (Tynn
     * #543). Holding an agent because another on its login hit the limit does not set it: that agent was interrupted by
     * nothing, so at the reset it is told nothing. Cleared when the reset is told, so it is told at most once per reset.
     */
    #cutByLimit = false;
    /** A non-allowed rate-limit reading arrived during the turn now running. */
    #limitThisTurn = false;
    /** Overloaded turns in a row (OVERLOAD_RETRY_MS); a turn that goes through resets it. */
    #overloads = 0;
    #overloadCancel: (() => void) | null = null;
    /** The Cooling wait (COOLING_MS) after a turn that ended cleanly, while it runs; `null` = not cooling. One per session. */
    #coolingCancel: (() => void) | null = null;
    #idleSince: number | null = null;
    #sleepingCancel: (() => void) | null = null;
    #turnState: TurnState = 'idle';
    #options: AgentSessionOptions;
    /** Rows that failed to persist. Kept so a storage fault is reportable, never silent. */
    #unpersisted = 0;
    /** Whether this run has said in its ledger that its history is not being saved (`#sayNotSaved`). */
    #notSavedSaid = false;
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
     * ONE PROMPT, ONE TURN. A prompt sent while a turn runs does not start a turn there. Claude Code takes it and usually
     * FOLDS it into the running turn (measured, the 2026-10-20 note in `onTurnEnd`), so no turn of its own may ever come;
     * Codex refuses a second prompt in flight, and `deliver` holds it for the turn's end (`#afterTurn`). A marker for it
     * is written only when a turn of its own starts: its first activity after the running turn ends, or a silent turn
     * end. Writing it at send time numbered it as the running turn, so the owner's record read `10, 10, 10, 10, 11, 12,
     * 14, 14…`: the same number per message sent mid-turn, and a gap for every one that never got a turn of its own (the
     * owner, 2026-10-14).
     */
    #inTurn = false;
    /**
     * Each prompt still waiting for its turn, oldest first: who sent it (`by`, as `prompt` takes it), and what it was, so
     * one Claude DROPS at a Stop (prism-acp 0.37.0, `#dropped`) can be sent again or kept as a draft.
     */
    #queued: Array<{ by: string | null; text: string; sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null; context: PromptContext }> = [];
    /**
     * THE DRIVER STOPPED ITSELF and will take no prompt again (prism-acp 0.37.0: Claude's cancel state uncertain,
     * `CANCEL_STATE_UNCERTAIN`). Not Broken — nothing about the agent is wrong — but this run is over: the person's next
     * message starts a new driver on the same conversation (`SessionHost.needsNewDriver`, main/start-on-demand.ts).
     */
    #needsNewDriver = false;
    /** An Interrupt is pending or was the last cancel asked of this run (Tynn #702): its queue is never dropped. */
    #interruptAsked = false;
    /** This run ended on an interrupt it could not confirm: what waits is kept for the next run (`carried`), never undelivered. */
    #carryQueue = false;
    /**
     * Who asked to stop the running turn (`cancel`'s `by`), until that turn ends. The cancelled turn's end is then
     * recorded as stopped BY them; a turn the provider reports cancelled with nobody here asking is recorded `by: null`.
     */
    #stopAskedBy: string | null = null;
    /** What the supervisor reported of this run's stop, when it has. */
    #nativeVerdict: NativeStopVerdict | null = null;
    /** Why the pending cancel was asked (`CancelIntent`): only a Stop latches `#stoppedByYou` (Tynn #672 part 3). */
    #stopIntent: CancelIntent = 'stop';
    /**
     * A STOP IS IN FLIGHT (Tynn #556): from the Stop until a prompt opens a fresh turn after it. A turn that ends crashed
     * meanwhile was ended by the Stop (the CLI killed under it), whatever the dying CLI said: stopped, never a limit hit.
     */
    #stopWindow = false;
    /** One confirmation deadline per turn; repeated Stop clicks cannot extend it. */
    #cancelPending: { by: string | null; intent: CancelIntent; cancel: () => void } | null = null;
    /** The run's tree as it was when the Stop was asked, read before any kill can orphan a tool (Tynn #556). */
    #stopCapture: Promise<readonly ProcessInfo[]> | null = null;
    /**
     * STOP MEANS STOP UNTIL THE PERSON ACTS (genie#1565): the person stopped the last turn they saw running, and has not
     * sent anything since. While set no inbox notice is handed over (`deliverable`); at the stop itself only what the person
     * queued was kept to send, which, if anything, ends the pause at once (`#keepOnlyYours`). The person's own message (`deliver`/`prompt` by `you`) or `resumeAfterStop` clears it. A turn the
     * provider ended, or one cancelled with nobody here asking, never sets it.
     */
    #stoppedByYou = false;
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
    /** The off-loop reading that settles `#roots` after the newest spawn on a tree with `read` + `capture`; a stop waits for it. */
    #rootsReading: Promise<void> | null = null;
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
     * written once when it closes rather than once per chunk. `messageId`: the provider's own id for it, when it gives one
     * (Codex's item id): a chunk with another id is another message.
     */
    #openMessage: { event: Extract<StreamEvent, { kind: 'message' | 'think' }>; persisted: boolean; messageId?: string | null } | null = null;
    /**
     * ROWS THAT ARRIVED BESIDE THE OPEN MESSAGE (genie#1456): emitted and written right after it closes (`#besideTheOpen`).
     * Holding them keeps the two rules everything downstream relies on: the growing message is the NEWEST row (the host's
     * `replacesLast` overwrites the last row, and `LiveReadings` reads that), and rows reach the thread in the order they
     * reached the screen.
     */
    #heldBeside: StreamEvent[] = [];
    /** A subagent's calls not yet answered, and the call that spawned each: a row of one is known as theirs even if it comes without the mark. */
    #subagentCalls = new Map<string, string>();
    /** The carry-over waiting for the next prompt, and the one sent with the turn now running (Tynn story #380). */
    #carryOver: CarryOver | null = null;
    #redockAt: string | null = null;
    #carryInFlight: CarryOver | null = null;
    /** Per-agent provider reading; a turn end arms delivery with the next accepted input. */
    #latestHeadroom: Headroom | null = null;
    #rateWarningPending = false;
    /** The prompt just sent, while its echo may still arrive, and how much of the echo has arrived. */
    #echo: string | null = null;
    #echoSeen = '';
    /** Writes in flight, chained so the thread records rows in the order they were emitted. */
    #writes: Promise<void> = Promise.resolve();
    /**
     * Rows waiting for the next write on the chain (Tynn #550): rows emitted together go to the thread together, as one
     * `record`, in order — one lock, one append, one sync — never one each.
     */
    #pendingRows: Array<{ event: StreamEvent; whole: string | null; images: readonly KeptImage[] }> = [];
    /** The chained write that will take `#pendingRows`, while it has not started. */
    #pendingWrite: Promise<void> | null = null;
    /**
     * The approval a human has not answered yet, and the resolver the PROVIDER is blocked on.
     *
     * Held together because they are one fact: a parked approval that nobody can resolve is a
     * provider process waiting forever, and a resolver with no question is a decision nobody
     * made.
     */
    #approval: { approval: Approval; resolve: (outcome: PermissionOutcomeLike) => void; request: PermissionRequestLike } | null = null;

    /** The agent's commands, skills, plugins and subagents, as its CLI last reported them (core/provider-commands.ts). */
    #extensions: ProviderExtensions | null = null;

    constructor(options: AgentSessionOptions) {
        this.#options = options;
        this.agentId = options.agentId;
        this.#carryOver = options.carryOver ?? null;
        this.#redockAt = options.redockAt ?? null;
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

    /**
     * The limit has reset (the gate's timer, or the person's Resume now): what waited goes out in order. Nothing waited ->
     * "continue", but ONLY to an agent whose last turn the limit cut off, once, and never to the OS agent (Tynn #543); any
     * other held agent is simply released.
     */
    resumeAfterLimit(): void {
        // A TURN STILL OPEN (Tynn #699): the limit's reading came mid-turn and the provider never ended that turn, so
        // what waited behind it could never go — `#flushAfterTurn` refuses while a turn is open. Genie ends the turn
        // itself; what waited, or the "continue", goes when its end comes.
        if (this.#held && this.running && this.#inTurn) {
            const nudge = (this.#cutByLimit || this.#limitThisTurn) && this.#options.limitNudge !== false;
            this.#cutByLimit = false;
            this.#held = false;
            this.#overloadCancel?.();
            this.#overloadCancel = null;
            if (nudge && !this.#afterTurn.some((p) => p.steer === undefined)) this.prompt(LIMIT_RESUME_PROMPT, 'genie');
            this.cancel('genie', 'interrupt');
            this.#changed();
            return;
        }
        const nudge = this.#cutByLimit && this.#options.limitNudge !== false;
        if (this.#held && this.running) this.#cutByLimit = false;
        this.#resumeHeld(nudge ? LIMIT_RESUME_PROMPT : null);
    }

    /** What waited goes out in order; nothing waited -> `nothingWaited`, as Genie's (`null`: nothing is sent). */
    #resumeHeld(nothingWaited: string | null): void {
        if (!this.#held || !this.running) return;
        this.#held = false;
        this.#overloadCancel?.();
        this.#overloadCancel = null;
        // A prompt steered into the held turn and not yet settled is not waiting to go (Tynn #440).
        if (!this.#afterTurn.some((p) => p.steer === undefined)) {
            if (nothingWaited !== null) this.prompt(nothingWaited, 'genie');
            else this.#changed();
            return;
        }
        this.#flushAfterTurn();
        this.#changed();
    }

    /**
     * QUIET: a restart now would cut nothing. Promptable, not on a limit, and past the Cooling wait, because
     * Claude can still open a turn of its own for a prompt it took mid-turn just after the last one ended (`#queued`).
     * For a restart Genie chooses by itself; the person's own Restart does not ask.
     */
    get quiet(): boolean {
        // What waits in `#afterTurn` here is held for the next run, and a run that ends leaves it owed.
        return this.promptable && !this.#held && this.#coolingCancel === null;
    }

    get turnState(): TurnState {
        return this.#turnState;
    }

    /**
     * COOLING (COOLING_MS): the turn ended cleanly less than 15 s ago and nothing has happened since — no new turn, no
     * stop. A status for the board to show and sort by, never a gate: `turnState` is `idle`, and `promptable` and
     * `deliverable` read exactly as they would without it.
     */
    get cooling(): boolean {
        return this.#coolingCancel !== null && this.#turnState === 'idle';
    }

    /** A clock for display only; prompts and mail never wait on Sleeping. */
    get idleSince(): number | null { return this.#turnState === 'idle' && !this.cooling ? this.#idleSince : null; }

    #startIdle(): void {
        this.#sleepingCancel?.();
        this.#idleSince = this.#now();
        this.#sleepingCancel = this.#later(SLEEPING_AFTER_IDLE_MS, () => {
            this.#sleepingCancel = null;
            if (this.#turnState === 'idle' && !this.cooling && this.running) this.#changed();
        });
    }

    /** Begin the Cooling wait, replacing one already running; its end is announced, so the board redraws it Idle. */
    #startCooling(): void {
        this.#stopCooling();
        this.#coolingCancel = this.#later(COOLING_MS, () => {
            this.#coolingCancel = null;
            this.#startIdle();
            this.#changed();
        });
    }

    #stopCooling(): void {
        this.#coolingCancel?.();
        this.#coolingCancel = null;
        this.#sleepingCancel?.();
        this.#sleepingCancel = null;
        this.#idleSince = null;
    }

    /** The injected timer, or `setTimeout` — unref'd, so a wait that only redraws a status never holds the process open. */
    #later(ms: number, fire: () => void): () => void {
        if (this.#options.retryLater) return this.#options.retryLater(ms, fire);
        const t = setTimeout(fire, ms);
        t.unref?.();
        return () => clearTimeout(t);
    }

    /**
     * A TURN IN FLIGHT, by Genie's own record (a prompt went in and its end has not come) — not `turnState: 'working'`,
     * which provider activity before any turn of this run reads as too. What a Restart asks before it tells the agent
     * its turn was cut (genie#1238): a restart pressed while the run was only coming up cut nothing.
     */
    get inTurn(): boolean {
        return this.#inTurn;
    }

    /**
     * STILL COMING UP: the driver declared a `ready` (Genie's own start always does — the MCP preparation and the
     * provider's handshake, main/deferred-driver.ts) that has not resolved. What the header and the chat show as
     * `Starting`, and what a first message waits for (q_04ce323c: start on first message, visibly).
     */
    get starting(): boolean {
        return this.#starting;
    }

    /**
     * Whether the session can take a NEW turn now — Genie's own reading, the same for every provider: alive, started (the
     * driver's declared `ready`, when it declares one), no turn in flight (Genie's own record, `#inTurn` — never inferred
     * from output), nothing parked on a person, and not broken or stopped. What the plan keep-alive waits for.
     *
     * Deliberately not `turnState === 'idle'`. A session just started USED to read `working` until a turn of its own
     * ended — with no turn running — so a notice for an agent started and mailed at once waited for somebody else to
     * prompt it (B26). It reads idle now (2026-11-01), but idle is still not enough: a session still STARTING is idle too,
     * and cannot take a turn until its `ready`.
     */
    get promptable(): boolean {
        return this.running && !this.#needsNewDriver && !this.#starting && !this.#inTurn && this.#approval === null && this.#turnState !== 'failed' && this.#turnState !== 'stopped';
    }

    /**
     * Whether a message handed over now reaches the agent at its NEXT STEP, the way the person's typed message does
     * (`deliver`): alive, started, not held on a limit, not broken or stopped. A turn in flight does not stop it — Claude
     * folds the message into the running turn; Codex has it held and sent when the turn ends. What the inbox push waits
     * for (genie#1411; the owner, 2026-11-01: "inbox nudges should queue up and post to the agent as soon as possible just
     * like user input"). Held is excluded: a notice is Genie's to tell again, so it waits out the limit untold, not queued.
     */
    get deliverable(): boolean {
        return this.running && !this.#needsNewDriver && !this.#starting && !this.#held && !this.#stoppedByYou && this.#turnState !== 'failed' && this.#turnState !== 'stopped';
    }

    /** This run's driver stopped itself and takes no prompt again: a new one is started for the next work (`#needsNewDriver`). */
    get needsNewDriver(): boolean {
        return this.#needsNewDriver;
    }

    /** The person stopped the last turn and has not acted since: notices wait and held input was left as drafts (genie#1565). */
    get stoppedByYou(): boolean {
        return this.#stoppedByYou;
    }

    /**
     * The person acted (sent, or sent a draft): what the stop paused goes on as usual. Not announced here: it is called
     * just before the person's own message goes, and an announcement now would let a waiting notice open its turn AHEAD
     * of that message. The caller's hand-over announces it.
     */
    resumeAfterStop(): void {
        this.#stoppedByYou = false;
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
    /**
     * Answer the parked request by a DECISION rather than a person's press (genie#1188: the tool setting changed while a
     * shell command waited) — with the request's own option of that ACP kind, recorded like any answer. `false` =
     * nothing parked.
     */
    settleApproval(decision: 'allow' | 'deny'): boolean {
        const held = this.#approval;
        if (!held) return false;
        const outcome = answerFor(held.request, decision);
        if (outcome.outcome === 'selected' && this.answerApproval(outcome.optionId)) return true;
        this.#approval = null;
        this.#parkedAt = null;
        held.resolve({ outcome: 'cancelled' });
        this.#options.onStateChange?.();
        return true;
    }

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
    #afterTurn: Array<{ id: string; text: string; by: string | null; sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null; context: PromptContext; steer?: string }> = [];

    /**
     * MAIL STEERED INTO A RUNNING CODEX TURN (prism-acp 0.38.0, Tynn #440), by the steer's fresh client id. Its prompt
     * stays in `#afterTurn`, marked (`steer`), so the turn's end does not send it again while it may still be seen; it
     * leaves when the record settles — `observed`: sent; `not_delivered` / `turn_ended_unobserved`: unmarked, held for
     * the turn's end as before; `unknown`: MAYBE delivered, so never sent again (`unconfirmed`).
     */
    #steers = new Map<string, { promptId: string; acceptance: 'pending' | 'accepted' | 'not_delivered' | 'unknown'; kind: string | null }>();

    /**
     * A MESSAGE FOR THE AGENT THAT MUST ARRIVE: sent now when the provider takes it (Claude reads it at its next step);
     * held for the end of the turn when it refuses a prompt mid-turn (Codex), then sent in order. An approval's note
     * (item 16) — from the card here, or from a Genie approval answered on the Deck (main/feature-ipc.ts).
     *
     * Answers what became of it: `null` = the provider has it now; an id = it is HELD (`#afterTurn`, `hasQueuedPrompt`)
     * and goes when a turn ends, the limit resets or the driver is ready.
     */
    deliver(text: string, by: string | null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null = null, context: PromptContext = {}): string | null {
        if (!this.running) throw new Error('session is not running');
        if (by === 'you') this.resumeAfterStop();
        // A prompt steered into the turn and still waiting to be seen is not ahead of this one.
        if (!this.#afterTurn.some((p) => p.steer === undefined) && !this.#starting) {
            try {
                return this.prompt(text, by, sent, context);
            } catch (error) {
                // A driver that has stopped itself takes nothing again: said, and a new one is needed (`#needsNewDriver`).
                if (cancelStateUncertain(error)) this.#driverStoppedItself();
                // Only a refusal DURING a turn can wait for its end. An idle driver failure must reach the caller.
                if (!this.#inTurn) throw error;
            }
        }
        const id = this.#queuePrompt(text, by, sent, context);
        this.#steerIntoTurn(id);
        return id;
    }

    /**
     * MAIL MID-TURN, FOR A PROVIDER THAT REFUSES A SECOND PROMPT BUT CAN BE STEERED (Codex >= 0.163 with prism-acp
     * 0.38.0, Tynn #440). The same full prompt Claude would be handed goes into the running turn under a FRESH client
     * id; the model takes it at its next step (after a running tool call returns; after a pending approval). It stays
     * held and marked until its record settles (`#steerSettled`). Only mail: the rest of what waits mid-turn is as before.
     */
    #steerIntoTurn(promptId: string): void {
        const driver = this.#driver;
        const p = this.#afterTurn.find((q) => q.id === promptId);
        if (!p || !driver?.steer || driver.steeringState?.supported !== true) return;
        if (!this.#inTurn || this.#held || this.#starting || this.#needsNewDriver || (p.context.mail?.length ?? 0) === 0) return;
        const clientId = randomUUID();
        p.steer = clientId;
        this.#steers.set(clientId, { promptId, acceptance: 'pending', kind: null });
        const content: readonly PromptBlock[] = p.sent?.content ?? [{ type: 'text', text: p.text }];
        let answer: Promise<SteerAcceptanceLike>;
        try {
            answer = driver.steer(content, { clientId });
        } catch {
            // Refused before anything was sent (unsupported, invalid input): held for the turn's end.
            this.#steerAnswered(clientId, 'not_delivered');
            return;
        }
        void answer.then((a) => this.#steerAnswered(clientId, a.outcome), () => this.#steerAnswered(clientId, 'not_delivered'));
    }

    #steerAnswered(clientId: string, outcome: SteerAcceptanceLike['outcome']): void {
        const s = this.#steers.get(clientId);
        if (!s) return;
        s.acceptance = outcome === 'accepted' || outcome === 'not_delivered' ? outcome : 'unknown';
        this.#steerSettled(clientId, true);
    }

    /** A steer's record, from `onSteerUpdate` (prism-acp publishes every change). */
    #steerRecord(record: SteerRecordLike): void {
        const s = this.#steers.get(record.steerId);
        if (!s) return;
        s.kind = record.kind;
        this.#steerSettled(record.steerId, true);
    }

    /** Act on what is known of one steer. `flush`: a prompt handed back to the queue may go now, if no turn runs. */
    #steerSettled(clientId: string, flush: boolean): void {
        const s = this.#steers.get(clientId);
        if (!s) return;
        const index = this.#afterTurn.findIndex((p) => p.id === s.promptId && p.steer === clientId);
        if (s.kind === 'observed') {
            // Seen in the turn: delivered, as Claude's folded prompt is. Nothing goes again at the turn's end.
            if (index >= 0) {
                this.#afterTurn.splice(index, 1);
                void this.#emitRow({ kind: 'prompt_delivery', id: s.promptId, status: 'sent' });
                this.#changed();
            }
            // Acknowledged only once its RPC answer is in, as prism-acp's contract asks.
            if (s.acceptance !== 'pending') {
                this.#steers.delete(clientId);
                this.#driver?.acknowledgeSteer?.(clientId);
            }
            return;
        }
        if (s.acceptance === 'not_delivered' || s.kind === 'not_delivered' || s.kind === 'turn_ended_unobserved') {
            // Not in that turn: held for the turn's end, exactly as without steering.
            if (index >= 0) delete this.#afterTurn[index]!.steer;
            if (s.acceptance !== 'pending') {
                this.#steers.delete(clientId);
                this.#driver?.acknowledgeSteer?.(clientId);
            }
            this.#changed();
            if (flush && !this.#inTurn) this.#flushAfterTurn();
            return;
        }
        if (s.acceptance === 'unknown' || s.kind === 'unknown') {
            // MAYBE delivered: never sent again (it could arrive twice), never claimed delivered. A later observation
            // only frees the record (`observed` above, with the prompt already gone from the queue).
            if (index >= 0) {
                this.#afterTurn.splice(index, 1);
                void this.#emitRow({ kind: 'prompt_delivery', id: s.promptId, status: 'unconfirmed' });
                this.#changed();
            }
        }
        // `accepted`, not yet seen: it stays marked until its record settles.
    }

    /** Records read back before the queue is drained: a callback that was missed still settles its steer. */
    #refreshSteers(): void {
        const driver = this.#driver;
        if (!driver?.steerState) return;
        for (const clientId of [...this.#steers.keys()]) {
            const record = driver.steerState(clientId);
            const s = this.#steers.get(clientId);
            if (!s || record.kind === 'not_known') continue;
            s.kind = record.kind;
            this.#steerSettled(clientId, false);
        }
    }

    /** One queue holds input waiting for either a turn or a provider pause. Answers the held prompt's id. */
    #queuePrompt(text: string, by: string | null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null, context: PromptContext): string {
        const id = randomUUID();
        this.#afterTurn.push({ id, text, by, sent, context });
        const kept = this.#keptImages(sent);
        const row = promptRow(text, by, sent, context, kept.refs);
        if (row.kind === 'message') void this.#emitRow({ ...row, pending: { id, content: sent?.content ?? null } }, kept.files);
        this.#changed();
        return id;
    }

    /** Drain until the provider refuses another input. Codex runs one per turn; Claude accepts queued input itself. */
    #flushAfterTurn(): void {
        if (this.#afterTurn.length === 0 || !this.running || this.#needsNewDriver || this.#starting || this.#approval !== null || this.#inTurn || this.#held || this.#options.mayTakeWork?.() === false) return;
        this.#refreshSteers();
        while (this.#afterTurn.length > 0 && this.running && this.#approval === null && !this.#held) {
            // A prompt steered into the turn just ended is not sent again while it may still be seen (Tynn #440).
            const next = this.#afterTurn.find((p) => p.steer === undefined);
            if (!next) return;
            try {
                this.#send(next.text, next.by, next.sent, false, next.context);
            } catch (error) {
                // One message started a turn. The rest still wait, including after a provider hold resumes.
                if (this.#inTurn) return;
                this.#leaveQueuedAsDrafts();
                void this.#emitRow({ kind: 'notice', level: 'error', message: `Queued input was not delivered: ${error instanceof Error ? error.message : String(error)}` });
                return;
            }
            this.#afterTurn.splice(this.#afterTurn.indexOf(next), 1);
            void this.#emitRow({ kind: 'prompt_delivery', id: next.id, status: 'sent' });
        }
    }

    /** The ids of the prompts held for the turn's end, in order — what the agent host tells a window (the host split). */
    get queuedPromptIds(): readonly string[] {
        return this.#afterTurn.map((p) => p.id);
    }

    hasQueuedPrompt(id: string): boolean {
        return this.#afterTurn.some((p) => p.id === id);
    }

    /**
     * A PROMPT AN EARLIER RUN OWES, handed to this one (genie#1238: Restart delivers what is owed). It keeps its own id and
     * its message row — already in the record — so the chat shows it once, where it was written, and its delivery row
     * (`sent`, or `undelivered` again if this run breaks before it goes) settles THAT message. Sent in queue order once the
     * run can take a turn: at once, at `ready`, or when the current turn ends. Already waiting here: nothing is added.
     */
    redeliver(id: string, text: string, by: string | null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null = null, context: PromptContext = {}, options: { hold?: boolean } = {}): void {
        if (!this.running) throw new Error('session is not running');
        if (this.hasQueuedPrompt(id)) return;
        this.#afterTurn.push({ id, text, by, sent, context });
        this.#changed();
        // `hold`: more are being handed over (`deliverOwed`); `flushOwed` sends them all together, in order (Tynn #702).
        if (options.hold !== true) this.#flushAfterTurn();
    }

    /** Send what `redeliver` held, all of it in order, as the queue sends (Tynn #702: a restart's owed messages go together). */
    flushOwed(): void {
        this.#flushAfterTurn();
        this.#changed();
    }

    discardPrompt(id: string): void {
        this.#afterTurn = this.#afterTurn.filter((p) => p.id !== id);
        void this.#emitRow({ kind: 'prompt_delivery', id, status: 'discarded' });
        this.#changed();
    }

    /**
     * What was held and can no longer go in this run becomes a DRAFT the next Restart owes (`deliverOwed`). Except a
     * Genie notice (`context.retold`): its sender tells it again on its own, so kept as owed it would arrive twice — it is
     * discarded instead, and the chat drops it (genie#1411).
     */
    #leaveQueuedAsDrafts(): void {
        const waiting = this.#afterTurn;
        this.#afterTurn = [];
        for (const p of waiting) void this.#emitRow({ kind: 'prompt_delivery', id: p.id, status: this.#leftStatus(p) });
    }

    /**
     * What a prompt leaving the queue unsent is recorded as. One steered with no answer yet may have been taken, so it
     * is never told again; one accepted and not seen settles as before (an interrupted turn leaves accepted input unseen).
     */
    #leftStatus(p: { context: PromptContext; steer?: string }): 'discarded' | 'undelivered' | 'unconfirmed' | 'carried' {
        if (p.steer !== undefined && this.#steers.get(p.steer)?.acceptance === 'pending') return 'unconfirmed';
        if (p.context.retold === true) return 'discarded';
        return this.#carryQueue ? 'carried' : 'undelivered';
    }

    /**
     * AFTER THE PERSON'S STOP (genie#1565): what the person queued stays queued; the rest is settled as
     * `#leaveQueuedAsDrafts` settles it — a Genie notice discarded (its sender tells it again), anything else a draft.
     */
    #keepOnlyYours(): void {
        const waiting = this.#afterTurn;
        this.#afterTurn = waiting.filter((p) => p.by === 'you');
        for (const p of waiting) {
            if (p.by !== 'you') void this.#emitRow({ kind: 'prompt_delivery', id: p.id, status: this.#leftStatus(p) });
        }
    }

    /**
     * A PROMPT THE STOP DROPPED (prism-acp 0.37.0's `cancel_queued`, genie#1565): settled by the rules a prompt HELD at
     * the Stop follows (`#keepOnlyYours`), so Claude and Codex agents stop alike —
     * - a Genie notice (`context.retold`) is not sent again: its sender tells it again (the turn it went into was stopped,
     *   so the inbox counts it untold) once the pause lifts;
     * - the person's own message goes, as its own turn — them acting (genie#1143) — and so does anyone's after a stop
     *   the person did not ask for;
     * - someone else's message after the person's Stop, or anything this run can no longer send (its driver stopped
     *   itself), is kept as a DRAFT the person can send and a Restart owes (`deliverOwed`).
     * Sent on the next microtask: prism-acp ends every dropped prompt in one go, and one sent in between would read the
     * next one's end as its own.
     */
    #dropped(p: { by: string | null; text: string; sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null; context: PromptContext }): void {
        if (p.context.retold === true) return;
        const id = randomUUID();
        if (this.#needsNewDriver || !this.running || (this.#stoppedByYou && p.by !== 'you')) {
            const kept = this.#keptImages(p.sent);
            const row = promptRow(p.text, p.by, p.sent, p.context, kept.refs);
            if (row.kind === 'message') void this.#emitRow({ ...row, pending: { id, content: p.sent?.content ?? null } }, kept.files);
            // Kept for the next run after an unconfirmed interrupt (Tynn #702), never "Not delivered".
            void this.#emitRow({ kind: 'prompt_delivery', id, status: this.#carryQueue ? 'carried' : 'undelivered' });
            return;
        }
        if (p.by === 'you') this.#stoppedByYou = false;
        this.#afterTurn.push({ id, text: p.text, by: p.by, sent: p.sent, context: p.context });
        queueMicrotask(() => {
            if (!this.#inTurn) this.#flushAfterTurn();
            this.#changed();
        });
    }

    /** The driver stopped itself (`CANCEL_STATE_UNCERTAIN`): said once; this run takes nothing more (`#needsNewDriver`). */
    #driverStoppedItself(): void {
        if (this.#needsNewDriver) return;
        this.#needsNewDriver = true;
        this.#stopCooling();
        // AN INTERRUPT NEVER DROPS THE QUEUE (Tynn #702): the agent starts again on the same conversation and what waited goes.
        if (this.#interruptAsked) {
            this.#carryQueue = true;
            void this.#emitRow({ kind: 'notice', level: 'warning', message: RESTARTED_FOR_QUEUE });
            this.#options.onRestartForQueue?.();
        } else {
            void this.#emitRow({ kind: 'notice', level: 'warning', message: 'The Stop could not be confirmed, so this run was ended to be sure nothing kept going. Your next message starts the agent again on the same conversation.' });
        }
        this.#changed();
        void this.#endStoppedTools();
    }

    /**
     * THE RUN'S TREE AT THE STOP (Tynn #556), read before the driver can end its CLI: what a tool started then (a Bash
     * tool's shell, its php) is known by pid, start time and name, so a kill that orphans it cannot hide it.
     */
    #captureForStop(): void {
        const tree = this.#options.processTree ?? systemProcessTree;
        const keep = (table: readonly ProcessInfo[] | null): readonly ProcessInfo[] => {
            const roots = this.#roots;
            if (!table || !roots || roots.length === 0) return [];
            const captured = subtreeOf(table, roots);
            this.#members = unionOf(this.#members, captured);
            // The run's own roots (its supervisor or shell) end with the run's stop; what is below them is the turn's.
            return captured.filter((p) => !roots.some((r) => r.pid === p.pid && r.started === p.started));
        };
        // A tree that reads off the loop is read off the loop; one that only reads synchronously is read NOW.
        if (!tree.read && !this.#rootsReading) {
            let table: readonly ProcessInfo[] | null = null;
            try { table = this.#roots && this.#roots.length > 0 ? tree.snapshot() : null; } catch { table = null; }
            this.#stopCapture = Promise.resolve(keep(table));
            return;
        }
        const read = tree.read ? tree.read.bind(tree) : (): Promise<readonly ProcessInfo[] | null> => Promise.resolve(tree.snapshot());
        this.#stopCapture = (this.#rootsReading ?? Promise.resolve()).then(() => read()).then(keep).catch(() => []);
    }

    /**
     * THE DRIVER ENDED ITS CLI after a Stop it could not confirm (Tynn #556): it ends the CLI only, so the stopped turn's
     * tools live on under a dead parent. Everything below the run's roots that the Stop's reading found and that still
     * runs is ended now, verified, and named in the chat. Never anything that reading did not find.
     */
    async #endStoppedTools(): Promise<void> {
        const captured = await (this.#stopCapture ?? Promise.resolve([] as readonly ProcessInfo[]));
        if (captured.length === 0) return;
        const tree = this.#options.processTree ?? systemProcessTree;
        const read = tree.read ? tree.read.bind(tree) : (): Promise<readonly ProcessInfo[] | null> => Promise.resolve(tree.snapshot());
        const reap = tree.reap ? tree.reap.bind(tree) : (targets: readonly ProcessInfo[], now: readonly ProcessInfo[]): Promise<ReapResult> => Promise.resolve(tree.killTree(targets, now));
        let now = await read().catch(() => null);
        if (!now) { void this.#emitRow({ kind: 'notice', level: 'warning', message: 'Genie could not read the machine’s processes to end what the stopped turn left running.' }); return; }
        const targets = stillRunning(captured, now);
        if (targets.length === 0) return;
        let result = await reap(targets, now);
        let left = targets;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            now = await read().catch(() => null);
            if (!now) break;
            left = stillRunning(targets, now);
            if (left.length === 0 || result.refused) break;
            await new Promise((r) => setTimeout(r, 250));
            result = await reap(left, now);
        }
        const message = now && left.length === 0
            ? `The Stop ended what the stopped turn left running: ${describeProcesses(targets)}.`
            : `Still running after the Stop: ${describeProcesses(left)}${result.refused && result.reason ? ` (${result.reason})` : ''}.`;
        void this.#emitRow({ kind: 'notice', level: left.length === 0 && now ? 'info' : 'warning', message });
        this.#changed();
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
                onSteerUpdate: (update) => {
                    if (this.#ended) return;
                    this.#steerRecord(update);
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
                    // CLAUDE'S CANCEL STATE UNCERTAIN (prism-acp 0.37.0): the driver ended its CLI to be sure the Stop
                    // stopped everything. Not a failure of the agent: the next message from the person starts a new one.
                    if (problem === CANCEL_STATE_UNCERTAIN) {
                        this.#driverStoppedItself();
                        return;
                    }
                    this.#turnState = 'failed';
                    this.#stopCooling();
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
                        // prism-acp's refusal of an old Claude Code becomes what to do (core/claude-cli-version.ts).
                        this.#failure = providerProblemWords(problem);
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
                        // Decided now, from the setting as it is now (genie#1188): allowed or refused at once, or parked.
                        const decided = this.#options.permissionDecision?.(request) ?? 'ask';
                        if (decided !== 'ask') { resolve(answerFor(request, decided)); return; }
                        const narrowed = approvalFrom(request);
                        const why = narrowed ? this.#options.askWhy?.() ?? null : null;
                        const approval = narrowed && why ? { ...narrowed, why } : narrowed;

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
                        this.#approval = { approval, resolve, request };
                        this.#parkedAt = this.#now();
                        this.#options.onStateChange?.();
                    }),
                onTurnEnd: (outcome) => {
                    if (this.#ended) { this.#straggler(); return; }
                    this.#clearCancelWait();
                    // Two turns are two replies even with nothing between them. Without this a
                    // whole conversation would accumulate into one unbounded row.
                    this.#closeMessage();
                    // An echo that never came is not still expected: a `you` row after this turn is a message, never
                    // the prompt's echo (see `#handle`).
                    this.#echo = null;
                    this.#echoSeen = '';

                    /*
                     * A PROMPT THE STOP DROPPED (prism-acp 0.37.0, genie#1565): Claude's interrupt sends `cancel_queued`,
                     * so a prompt it took mid-turn never runs; each ends on its own, cancelled, AFTER the stopped turn (raw
                     * `dropped by cancel`, or `cancel accounting mismatch` when the receipt could not be trusted). It was
                     * never a turn: no marker, no `stopped` row, no count. Ended while Genie holds no turn open with a
                     * prompt still waiting for one, cancelled — a prompt that did start ran as a turn and opened it.
                     */
                    if (!this.#inTurn && outcome.stopReason === 'cancelled' && !outcome.isError && this.#queued.length > 0) {
                        this.#dropped(this.#queued.shift()!);
                        this.#changed();
                        return;
                    }

                    // A provider turn that ends while Genie holds none open ran SILENTLY — no reply, no tool — so nothing
                    // opened its marker: it is the oldest queued prompt's turn, marked now. Nothing queued: no prompt's
                    // turn, and it opens nothing, as before.
                    if (!this.#inTurn && this.#queued.length > 0) void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by: this.#queued.shift()?.by ?? null });

                    this.#turns += 1;
                    this.#endedThisRun += 1;
                    this.#inTurn = false;
                    // Arm before queued mail is flushed. This never sends input or starts a turn by itself.
                    this.#rateWarningPending = rateLimitWarning(this.#latestHeadroom, this.#now()) !== null;

                    // A turn that did not finish cleanly is `failed`, not `idle`. Reporting
                    // idle would present a crashed turn as a completed one, which is the
                    // quietest way to lose work: the agent stops, the board says nothing is
                    // wrong, and nobody looks.
                    //
                    // A CANCELLED turn is the exception and is idle: cancelling is something
                    // the human did, and painting it as a fault blames the agent for being
                    // stopped.
                    const crashed = outcome.stopReason === null || outcome.isError;
                    // ENDED BY A STOP (Tynn #556): the person's Stop, the driver ending its CLI after one it could not confirm,
                    // or this run's own stop. Whatever the dying CLI reported, that is not a limit, a sign-out or a fault.
                    const endedByStop = crashed && (this.#stopWindow || this.#needsNewDriver || this.#ended);
                    const failed = crashed && !endedByStop;
                    // Ended by the limit: a reading said so during the turn, or the turn's own failure does (Tynn #791).
                    const readingSaidSo = this.#limitThisTurn;
                    const stoppedAtLimit = readingSaidSo && this.#stopWindow;
                    const byLimit = failed && (readingSaidSo || outcome.failure?.kind === 'rate_limit');
                    // Ended by the LOGIN (the owner, 2026-10-18): the provider says this account is not signed in.
                    // Ended by the ACCOUNT (the owner, 2026-10-21: a payment failure paused it): checked before the login,
                    // because prism-acp files `oauth_org_not_allowed` under `auth` and logging in does not fix it.
                    const paused = failed && !byLimit ? accountPauseOf(outcome.failure) : null;
                    const bySignOut = failed && !byLimit && paused === null && outcome.failure?.kind === 'auth';
                    // Overloaded (the provider's, and it passes): waited out and sent on again, until OVERLOAD_RETRY_MS runs out.
                    const byOverload = failed && !byLimit && paused === null && !bySignOut && outcome.failure?.kind === 'overloaded' && this.#overloads < OVERLOAD_RETRY_MS.length;
                    this.#lastTurnEnd = byLimit || byOverload ? 'held' : bySignOut ? 'signed-out' : failed ? 'failed' : outcome.stopReason === 'cancelled' || endedByStop ? 'stopped' : 'replied';
                    // The carry-over this turn took: gone with a reply; otherwise the next prompt carries it again (Tynn story #380).
                    if (this.#carryInFlight !== null) {
                        const carried = this.#carryInFlight;
                        this.#carryInFlight = null;
                        if (this.#lastTurnEnd === 'replied') this.#options.onCarryOverSent?.();
                        else this.#carryOver ??= carried;
                    }
                    this.#limitThisTurn = false;
                    if (stoppedAtLimit && !byLimit) this.#sayStoppedAtLimit();
                    if (byLimit) {
                        // HELD, not failed (Tynn #793): the provider's own reading said its limit was reached. Nothing is
                        // Broken; the agent waits for the limit to reset and is resumed then.
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                        this.#held = true;
                        // ITS turn was cut off: at the reset it is told to continue, once (Tynn #543).
                        this.#cutByLimit = true;
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
                        this.#overloadCancel = this.#later(ms, () => { this.#overloadCancel = null; this.#resumeHeld(OVERLOAD_RESUME_PROMPT); });
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
                    } else if (endedByStop) {
                        // Stopped, as the person asked: idle, nothing Broken and nothing held.
                        this.#turnState = 'idle';
                        this.#failure = null;
                        this.#failedAt = null;
                    } else if (failed) {
                        this.#turnState = 'failed';
                        // The provider's own reason (`authentication_failed`, `overloaded`…) says more than the CLI's generic one.
                        const reason = outcome.failure?.reason ?? outcome.raw;
                        this.#failure = reason === null ? null : providerProblemWords(reason);
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
                    const intent = this.#stopIntent;
                    this.#stopAskedBy = null;
                    this.#stopIntent = 'stop';
                    // STOP MEANS STOP (genie#1565): set before the row below, which listeners can act on at once. Only the
                    // person's STOP latches: an interrupt-and-send cancels the turn so their message runs next, and that
                    // message is the next work, so Genie's notices are not held for them to type again (Tynn #672 part 3).
                    const stoppedByYou = outcome.stopReason === 'cancelled' && !outcome.isError && stopper === 'you' && intent === 'stop';
                    if (stoppedByYou) this.#stoppedByYou = true;
                    // A turn that ends cleanly closes the interrupt; one ended by its run's own stop keeps it (Tynn #702).
                    if (!this.#needsNewDriver) this.#interruptAsked = false;
                    // No "Stopped" for a run an unconfirmed interrupt ended: the agent starts again at once, and says so.
                    if (outcome.stopReason === 'cancelled' && !outcome.isError && !this.#carryQueue) void this.#emitRow({ kind: 'stopped', n: Math.max(this.#marked, this.#turns), by: stopper });
                    // A TURN THAT FINISHED SAYS SO too (beta.33 item 10): the lanes' "finished" is this row, as it happens —
                    // never the agent's last handoff, which a session answering in chat never files.
                    if (this.#lastTurnEnd === 'replied') void this.#emitRow({ kind: 'finished', n: Math.max(this.#marked, this.#turns) });
                    // COOLING (COOLING_MS): only a turn that REPLIED — a failed, stopped, held or signed-out turn keeps its
                    // own state. Started before the flush below: a prompt that waited opens a turn there, which ends it.
                    if (this.#lastTurnEnd === 'replied') this.#startCooling();
                    else this.#stopCooling();
                    // A QUEUED PROMPT IS NOT ASSUMED TO BECOME A TURN (the owner, 2026-10-20: idle agents not woken by
                    // mail). Claude Code FOLDS a prompt sent mid-turn into the running turn; opening its turn here left a
                    // phantom one that never ended — moic `working` for 36 minutes while idle, so no inbox notice and the
                    // owner's next message queued behind it. The agent is idle now; a turn opens when the PROVIDER starts
                    // one (its first activity, credited to the oldest queued sender) or ends one silently (above). After a
                    // crashed turn nothing is assumed to run: the queue is dropped and the failure stands.
                    if (crashed) this.#queued = [];
                    // After a stop nothing is assumed either: since prism-acp 0.37.0 Claude DROPS what it took mid-turn,
                    // and each such prompt ends on its own after this one (`#dropped`). It used to run it after the
                    // interrupt, and its turn was opened here.
                    // A note the provider refused mid-turn (an approval's, item 16) goes now, as its own turn.
                    if (crashed && !byLimit && !byOverload) this.#leaveQueuedAsDrafts();
                    // EXCEPT after the person's own Stop (genie#1565; the owner's Codex agent, beta.58: "Stopped by you",
                    // then at once a new turn for an inbox notice held mid-turn). Only what the PERSON queued goes on
                    // (genie#1143: cancelling a turn preserves their queue; Claude runs theirs after the interrupt too),
                    // and its going is them acting. Genie's notice is dropped for its book to tell once they act;
                    // anyone else's message is left as a draft for them to send.
                    else if (stoppedByYou) {
                        this.#keepOnlyYours();
                        if (this.#afterTurn.length > 0) {
                            this.#stoppedByYou = false;
                            if (!this.#inTurn) this.#flushAfterTurn();
                        }
                    }
                    else if (!this.#inTurn) this.#flushAfterTurn();
                    // Announced AFTER the state is set: announced before, every listener read `working` and nothing
                    // announced again — the doctor channel waited out its timeout and the board kept a finished turn as
                    // Working (found in the first doctor trial, 2026-10-13).
                    this.#changed();
                },
                onStopVerdict: (verdict) => { this.#nativeVerdict = verdict; },
                onExit: (code, signal) => {
                    this.#clearCancelWait();
                    this.#leaveQueuedAsDrafts();
                    // A retry waiting out an overload has nobody to send to now.
                    this.#overloadCancel?.();
                    this.#overloadCancel = null;
                    this.#stopCooling();
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
        const aroundSpawn = (spawn: () => void): void => {
            if (tree.read && tree.capture) {
                /*
                 * NOTHING READ ON THE LOOP (beta.53 freezes: the two `snapshot()` readings below were PowerShell on main,
                 * 2–20 s each on Windows, around every spawn — eleven agents resuming held the window for minutes). The
                 * spawn's own children are captured as they are created; their start times and trees come from a
                 * reading off the loop. The newest spawn's reading is the one kept; a stop waits for it (`#rootsReading`).
                 */
                const pids: number[] = [];
                const read = tree.read.bind(tree);
                const reading: Promise<void> = Promise.resolve().then(async () => {
                    let after = await read().catch(() => null);
                    if (after === null && this.#rootsReading === reading) after = await read().catch(() => null);
                    if (this.#rootsReading !== reading) return;
                    if (after === null) {
                        // Still no reading. A crash must not leave this provider unrecorded, so its pid goes in with no start time: said at every boot, and never reaped.
                        this.#roots = null;
                        this.#options.onSpawned?.(pids.map((pid) => startTimeUnknown(pid, process.pid)));
                        this.#options.onReadingFailed?.(pids);
                        return;
                    }
                    this.#roots = after.filter((p) => pids.includes(p.pid) && p.ppid === process.pid);
                    this.#members = subtreeOf(after, this.#roots);
                    this.#options.onSpawned?.(this.#members);
                });
                this.#rootsReading = reading;
                tree.capture(spawn, pids);
                return;
            }
            const before = tree.snapshot();
            try { spawn(); }
            finally {
                const after = before === null ? null : tree.snapshot();
                if (before !== null && after !== null) {
                    this.#roots = newChildrenOf(before, after, process.pid);
                    this.#members = subtreeOf(after, this.#roots);
                    this.#options.onSpawned?.(this.#members);
                } else this.#roots = null;
            }
        };
        if (this.#driver.startTracked) this.#driver.startTracked(aroundSpawn);
        else aroundSpawn(() => this.#driver!.start());
        this.#alive = true;
        // READY, when the driver declares when (see `SessionDriver.ready`): announced, so whatever waits for it (the inbox
        // push) is told without polling. A rejection is still the end of starting — the failure itself arrives through
        // the driver's own events (`onProtocolError`, `onExit`), which is where it is reported.
        const ready = this.#driver.ready;
        if (ready !== undefined) {
            this.#starting = true;
            const done = (): void => {
                this.#starting = false;
                if (this.#turnState === 'idle' && this.#idleSince === null) this.#startIdle();
                this.#changed();
            };
            // A prompt queued while it started opens its turn in the flush. That needs no announcement of its own: the
            // rows it writes (its turn marker, its `prompt_delivery`) are each pushed, the last already reading `working`
            // — a second push for the same moment only costs the window (genie#1418, batch B).
            ready.then(() => { done(); this.#options.onStartSettled?.(true); this.#flushAfterTurn(); }, () => { done(); this.#options.onStartSettled?.(false); });
        }
        // The turns continue from the record's last, so a restarted agent's next turn is not "Turn 1" again beside the
        // turns it already had.
        // Known at start (the record's last turn): nothing to count. Otherwise counted from the record, asynchronously.
        if (this.#options.turnsBefore === undefined) {
            const startedAt = Date.now();
            // Only the last turn's number is wanted: no rows (`limit: 0`), so a long record is counted, not parsed (genie#1340).
            void readHistory(this.#options.store, this.agentId, { before: startedAt, limit: 0, ...(this.#options.runId !== undefined ? { run: this.#options.runId } : {}) })
                .then((h) => { const recorded = h.lastTurn; this.#turns += recorded; this.#marked += recorded; })
                .catch(() => { /* no record yet: turns start at 1 */ });
        }
        // STARTED IS NOT WORKING (the owner, 2026-11-01, on beta.55: "an agent should not show as working when I haven't
        // started it yet"). This read `working` until a turn of its own ended, with no turn running, so an agent opened
        // and never prompted showed `Turn 0 · running`, a `Stop this turn`, `Working` in the rail, and a setting change
        // waited for a turn that never came. It is idle until a prompt opens a turn or the provider starts working.
        this.#turnState = 'idle';
        if (!this.#starting) this.#startIdle();
    }

    /**
     * `by` is who started the turn when the caller knows (`you` from the composer, `genie` for a reminder or a
     * handoff ask, a peer's name) — written into the ledger as the turn's marker, and `null` when nobody said.
     * Answers `null` when the provider took it, or the id it is held under (held on a limit, or still starting).
     */
    prompt(text: string, by: string | null = null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null = null, context: PromptContext = {}): string | null {
        if (!this.#driver) throw new Error('session is not started');
        if (by === 'you') this.resumeAfterStop();
        if (this.#held || this.#starting || this.#options.mayTakeWork?.() === false) return this.#queuePrompt(text, by, sent, context);
        this.#send(text, by, sent, true, context);
        return null;
    }

    /** Whether this agent's provider runs its commands as commands (`SessionDriver.runCommand`), not as prompt text. */
    get runsCommands(): boolean {
        return typeof this.#driver?.runCommand === 'function';
    }

    /**
     * RUN THE PROVIDER'S OWN COMMAND (Tynn #440): `/compact` typed to a Codex agent is Codex's compaction, never a chat
     * message. It opens a turn as a prompt does — your `/compact` in the chat, Working — and that turn ends when the
     * provider reports the command done. Answers `null` when it was handed over, or why it was not: refused at once
     * when a turn is running or the agent cannot take one; a refusal from the provider (`CommandUnsupported`) arrives
     * later, said in the chat with its reason, and no turn is left running.
     */
    runCommand(name: string, text: string, by: string | null): string | null {
        const driver = this.#driver;
        if (!driver?.runCommand) return `/${name} was not run: this agent runs no commands.`;
        if (!this.running || this.#starting || this.#held || this.#inTurn || this.#approval !== null || this.#needsNewDriver || this.#options.mayTakeWork?.() === false) {
            return `/${name} was not run: the agent is busy.`;
        }
        if (by === 'you') this.resumeAfterStop();
        let accepted: Promise<void>;
        try {
            accepted = driver.runCommand(name);
        } catch (error) {
            return `/${name} was not run: ${commandRefusalWords(error)}.`;
        }
        const endedBefore = this.#endedThisRun;
        this.#queued = [];
        void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by });
        this.#inTurn = true;
        this.#limitThisTurn = false;
        void this.#emitRow(promptRow(text, by, null, {}));
        this.#turnState = 'working';
        this.#stopCooling();
        this.#changed();
        void accepted.catch((error: unknown) => {
            void this.#emitRow({ kind: 'notice', level: 'warning', message: `/${name} did not run: ${commandRefusalWords(error)}.` });
            // No turn comes of a refused command: the one opened for it is closed here, unless the provider ended it.
            if (this.#inTurn && this.#endedThisRun === endedBefore && !this.#ended) {
                this.#inTurn = false;
                this.#turnState = 'idle';
                this.#startIdle();
                this.#flushAfterTurn();
            }
            this.#changed();
        });
        return null;
    }

    /** A word from Genie held for the next turn this session opens (`holdForNextWork`); `null` = none. */
    #heldForNextWork: string | null = null;
    #heldSent: (() => void) | null = null;
    #heldShownAs: string | null = null;

    /**
     * It goes ahead of the next prompt that opens a turn, and starts none of its own. Replaces one already held.
     * `shownAs`: the one line the chat shows in its place. Instruction text is for the agent; the person is told only that
     * it was sent (Tynn #615: the whole of Genie's instructions was drawn in the chat as a message from genie).
     */
    holdForNextWork(text: string, sent: (() => void) | null = null, shownAs: string | null = null): void {
        this.#heldForNextWork = text;
        this.#heldSent = sent;
        this.#heldShownAs = shownAs;
    }

    /** Work is held (`mayTakeWork`, a limit, a start). */
    get workWaiting(): boolean {
        return this.#afterTurn.length > 0;
    }

    /** `mayTakeWork` says yes again: what it held goes now, or when the turn ends. */
    releaseWork(): void {
        this.#flushAfterTurn();
        this.#changed();
    }

    /** True = it was still held, and now it is not. */
    withdrawHeld(): boolean {
        const was = this.#heldForNextWork !== null;
        this.#heldForNextWork = null;
        this.#heldSent = null;
        this.#heldShownAs = null;
        return was;
    }

    /** Hand a prompt to the provider and open (or queue) its turn; `record` writes its message row too. */
    #send(text: string, by: string | null, sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null, record = false, context: PromptContext = {}): void {
        if (!this.#driver) throw new Error('session is not started');
        // The provider takes it FIRST: a prompt it refuses (Codex while a turn runs, a driver that throws) writes nothing
        // and leaves the session as it was — it used to leave a turn marker and your message for a turn that never ran,
        // "in a turn" with nothing running (Working, and a clock that never moved), and the next prompt reused the number.
        // The hand-off is synchronous, so the marker below still lands before the provider's first frame.
        // A switch's carry-over goes above the person's words, once (Tynn story #380): only what the provider gets.
        const carry = this.#carryOver;
        const redockAt = this.#inTurn ? null : this.#redockAt;
        const redock = redockAt === null ? null : redockReorientation(redockAt);
        // Recheck the newest reading and its reset at delivery, not when this turn's notice was armed.
        const rateWarning = this.#rateWarningPending ? rateLimitWarning(this.#latestHeadroom, this.#now()) : null;
        const above = `${rateWarning ? `${rateWarning}\n\n---\n\n` : ''}${carry ? `${carry.text}\n\n---\n\n` : ''}${redock ? `${redock}\n\n---\n\n` : ''}`;
        // Not into a running turn: a prompt folded there is not the next work, and the turn is not told mid-way.
        // What Genie held for the next work goes between the carry-over and the person's words.
        const held = this.#inTurn ? null : this.#heldForNextWork;
        const heldShownAs = held === null ? null : this.#heldShownAs;
        const handed = held === null ? text : `${held}\n\n${text}`;
        const lead: PromptBlock[] = [...(above ? [{ type: 'text' as const, text: above }] : []), ...(held !== null ? [{ type: 'text' as const, text: held }] : [])];
        this.#driver.prompt(sent ? (lead.length > 0 ? [...lead, ...sent.content] : sent.content) : `${above}${handed}`);
        if (redockAt !== null) {
            this.#redockAt = null;
            this.#options.onRedockSent?.(redockAt);
        }
        this.#rateWarningPending = false; // A refused prompt leaves it pending for the next accepted input.
        if (carry) { this.#carryOver = null; this.#carryInFlight = carry; }
        if (held !== null) {
            const sentNow = this.#heldSent;
            this.#heldForNextWork = null;
            this.#heldSent = null;
            this.#heldShownAs = null;
            sentNow?.();
        }
        // The marker lands BEFORE the provider's first frame, so every row that follows is inside this turn — unless a
        // turn is running, when this prompt waits for its own (see `#queued`).
        if (this.#inTurn) this.#queued.push({ by, text, sent, context });
        else {
            // Whatever the queue still holds was folded into an earlier turn (no turn of its own came): not ahead of this.
            this.#queued = [];
            void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by });
            this.#inTurn = true;
            this.#limitThisTurn = false;
            this.#stopWindow = false;
        }
        // What the turn carried, marked where it happened: the exact text sent, opened from the chat — never your message.
        if (redock) void this.#emitRow({ kind: 'notice', level: 'info', message: redock });
        if (carry) void this.#emitRow({ kind: 'notice', level: 'info', message: carriedLabel(carry), carried: { from: carry.from, turns: carry.turns, text: carry.text } });
        if (rateWarning) void this.#emitRow({ kind: 'notice', level: 'warning', message: rateWarning });
        // YOUR MESSAGE, recorded as it is sent. Claude does not echo a prompt back, so waiting for the wire's
        // `user_message_chunk` left the owner's own words out of the thread. A peer's prompt is that peer's message.
        // What Genie put ahead of it is shown as Genie's, not as part of the person's words.
        // Instruction text is never drawn: one line says it was sent (Tynn #615).
        if (held !== null) void this.#emitRow(heldShownAs !== null ? { kind: 'notice', level: 'info', message: heldShownAs } : promptRow(held, 'genie', null, {}));
        if (record) { const kept = this.#keptImages(sent); void this.#emitRow(promptRow(text, by, sent, context, kept.refs), kept.files); }
        // A provider that DOES echo it is not recorded twice (see `#handle`) — the carry-over and held text above it included.
        this.#echo = `${above}${handed}`;
        this.#echoSeen = '';
        this.#turnState = 'working';
        // A new turn during Cooling goes straight to Working, and its timer goes with it.
        this.#stopCooling();
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
        this.#clearCancelWait();
        this.#ended = true;
        this.#overloadCancel?.();
        this.#overloadCancel = null;
        this.#stopCooling();
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
        /*
         * The tree BEFORE the provider is told to end, read OFF the loop on a tree that can (beta.53 freezes: this was a
         * PowerShell reading on main before every graceful stop — a restart, a hibernate, a quit). It waits for the
         * start's own reading first, so a stop asked right after a start still knows the spawn's processes.
         */
        const read = tree.read?.bind(tree);
        const earlyOffLoop = read && tree.capture
            ? (async (): Promise<void> => {
                await this.#rootsReading;
                const roots = this.#roots;
                if (!roots || roots.length === 0) return;
                const early = await read().catch(() => null);
                if (early) this.#members = unionOf(this.#members, subtreeOf(early, roots));
            })()
            : null;
        const earlyOnLoop = (): void => {
            const early = this.#roots && this.#roots.length > 0 ? tree.snapshot() : null;
            if (early && this.#roots) this.#members = unionOf(this.#members, subtreeOf(early, this.#roots));
        };
        if (graceMs > 0 && driver?.stop && this.#alive && !this.#exited) {
            // PRISM-ACP 0.21.1 OWNS THE TREE: its stop closes stdin, waits the grace, ends the supervised tree (a Job Object
            // on Windows) and reports. Genie's reading then verifies it as before — and reaps anything it still finds.
            const stopDriver = driver.stop.bind(driver);
            const ended = (earlyOffLoop ?? Promise.resolve(earlyOnLoop())).then(() => stopDriver({ graceMs }));
            // The supervisor counted the tree itself and nothing is left: Genie's own sweep has nothing to add. Anything less
            // (a count nobody observed, survivors, a failed stop) gets the sweep (Tynn #575).
            this.#stopping = ended.catch(() => undefined).then((returned): Promise<StopVerdict> | StopVerdict => {
                const native = this.#nativeVerdict ?? (returned as NativeStopVerdict | undefined);
                return native?.verified === true && native.empty === true ? { verified: true, ended: this.#members.length } : this.#endTree(tree, signal);
            });
        } else if (graceMs > 0 && driver?.endInput && this.#alive && !this.#exited) {
            // The tree BEFORE stdin closes: a provider that then ends on its own (on Windows) orphans its children, and
            // a reading after its exit could no longer reach them from the roots.
            const endInput = driver.endInput.bind(driver);
            const close = (): void => { try { endInput(); } catch { /* a stdin already closed: the kill below ends it */ } };
            if (earlyOffLoop) {
                this.#stopping = earlyOffLoop.then(close).then(() => this.#exitWithin(graceMs)).then(() => this.#endTree(tree, signal));
            } else {
                earlyOnLoop();
                close();
                this.#stopping = this.#exitWithin(graceMs).then(() => this.#endTree(tree, signal));
            }
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
        if (tree.read && tree.reap) {
            const read = tree.read.bind(tree);
            const reap = tree.reap.bind(tree);
            // The start's own reading first (a stop right after a start): its roots are what this ends.
            return (this.#rootsReading ?? Promise.resolve()).then(() => this.#endTreeAsync(read, reap, signal));
        }
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

    /**
     * `#endTree` with a tree that reads WITHOUT HOLDING THE EVENT LOOP — Genie's own (genie#1201: a quit or an install
     * stopping every agent ran one PowerShell reading after another on main, and Windows painted the window "not
     * responding"). The same steps and the same verdicts: the tree read BEFORE the kill (the kill is what orphans), every
     * process of the run reaped, a fresh reading verifying it, a survivor named. Only the waiting is different.
     */
    async #endTreeAsync(
        read: () => Promise<readonly ProcessInfo[] | null>,
        reap: (targets: readonly ProcessInfo[], now: readonly ProcessInfo[]) => Promise<ReapResult>,
        signal: NodeJS.Signals,
    ): Promise<StopVerdict> {
        const roots = this.#roots;
        const before = roots && roots.length > 0 ? await read() : null;
        if (before && roots) this.#members = unionOf(this.#members, subtreeOf(before, roots));
        const targets = before ? stillRunning(this.#members, before) : [];

        this.#driver?.kill(signal);
        const reaped = await reap(targets, before ?? []);

        if (roots === null) return { verified: false, reason: 'Genie could not read this agent’s processes when it started, so it cannot verify they ended.', survivors: [] };
        if (roots.length > 0 && before === null) return { verified: false, reason: 'Genie could not read the machine’s processes to end this agent’s tree.', survivors: [] };
        if (this.#members.length === 0) return { verified: true, ended: 0 };
        // A process just killed can take a moment to leave the table: look, and kill what is left again, a few times.
        for (let attempt = 0; ; attempt += 1) {
            const now = await read();
            if (now === null) return { verified: false, reason: 'Genie could not read the machine’s processes to verify this agent ended.', survivors: [] };
            const survivors = stillRunning(this.#members, now);
            if (survivors.length === 0) return { verified: true, ended: this.#members.length };
            if (reaped.refused) return { verified: false, reason: reaped.reason ?? 'The reap was refused.', survivors };
            if (attempt >= 3) return { verified: false, reason: `Still running after the stop: ${describeProcesses(survivors)}.`, survivors };
            await new Promise((r) => setTimeout(r, 250));
            await reap(survivors, now);
        }
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
     * - **A driver that cannot cancel is never killed instead.** A supported cancel that remains unconfirmed is
     *   bounded: Genie ends that run, keeps what it owes, and a new driver resumes the same conversation when needed.
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

    /** Tests-first live-command publication seam (#633); implementation follows measured RED. */
    commandStarted(_run: CommandRunRef): void {}

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

    /**
     * Whether `modelState()` / `switchModel()` would answer rather than `null` — read without asking the provider, so the
     * agent host can tell a window that is not in its process (the host split, phase 1).
     */
    get canSayModels(): boolean {
        return Boolean(this.#driver) && !this.#exited && this.#alive && typeof this.#driver?.modelState === 'function';
    }

    get canSwitchModel(): boolean {
        return Boolean(this.#driver) && !this.#exited && this.#alive && typeof this.#driver?.setModel === 'function';
    }

    /** Ask the running provider to read its rate limits, or `null` when nothing is running or it cannot (`SessionDriver.readRateLimits`). */
    get canReadRateLimits(): boolean {
        return Boolean(this.#driver) && !this.#exited && this.#alive && typeof this.#driver?.readRateLimits === 'function';
    }

    readRateLimits(): Promise<void> | null {
        const driver = this.#driver;
        if (!driver || this.#exited || !this.#alive || typeof driver.readRateLimits !== 'function') return null;
        return driver.readRateLimits();
    }

    /** Switch the running session's model, or `null` when nothing is running or the driver cannot (`SessionDriver.setModel`). */
    switchModel(modelId: string): Promise<void> | null {
        const driver = this.#driver;
        if (!driver || this.#exited || !this.#alive || typeof driver.setModel !== 'function') return null;
        return driver.setModel(modelId);
    }

    /** `intent`: why (`CancelIntent`); only a Stop latches the session until the person acts (Tynn #672 part 3). */
    cancel(by: string | null = 'you', intent: CancelIntent = 'stop'): CancelOutcome {
        const driver = this.#driver;
        if (!driver || this.#exited || !this.#alive) return { ok: false, reason: 'not-running' };
        if (!this.#inTurn) return { ok: false, reason: 'no-turn' };
        if (typeof driver.cancel !== 'function') {
            void this.#emitRow({ kind: 'notice', level: 'warning', message: 'This agent cannot stop a turn on its own. The turn is still running; Stop agent ends the session.' });
            this.#changed();
            return { ok: false, reason: 'unsupported' };
        }
        this.#stopAskedBy = by;
        this.#stopIntent = intent;
        this.#interruptAsked = intent === 'interrupt';
        this.#stopWindow = true;
        if (this.#cancelPending !== null) {
            this.#cancelPending.by = by;
            this.#cancelPending.intent = intent;
            return { ok: true };
        }
        const pending = { by, intent, cancel: (): void => {} };
        this.#cancelPending = pending;
        pending.cancel = this.#later(TURN_CANCEL_WAIT_MS, () => {
            if (this.#cancelPending !== pending) return;
            this.#clearCancelWait();
            this.#endUnconfirmedTurn(pending.by, pending.intent);
        });
        this.#captureForStop();
        const refused = (cause: unknown): void => {
            // The provider's promise can settle after its turn ended, even after another Stop was asked.
            if (this.#cancelPending !== pending) return;
            const why = cause instanceof Error ? cause.message : String(cause);
            void this.#emitRow({ kind: 'notice', level: 'warning', message: `The turn could not be stopped: ${why}. Genie will end this run if the turn does not stop within ${TURN_CANCEL_WAIT_MS / 1000} seconds.` });
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

    #clearCancelWait(): void {
        const pending = this.#cancelPending;
        this.#cancelPending = null;
        pending?.cancel();
    }

    #sayStoppedAtLimit(): void {
        void this.#emitRow({ kind: 'notice', level: 'warning', message: 'The provider reported a rate limit during this turn. The turn is stopped; your queued messages remain available when the limit clears.' });
    }

    /** No turn-end frame arrived. End the old run instead of claiming an idle provider that is still working. */
    #endUnconfirmedTurn(by: string | null, intent: CancelIntent): void {
        if (this.#ended || !this.#inTurn) return;
        const limited = this.#limitThisTurn;
        this.#interruptAsked = intent === 'interrupt';
        this.#driverStoppedItself();
        // Accepted mid-turn prompts normally get separate cancelled frames from the provider. A silent one sends
        // none: retain those prompts using the same draft/carry rules before stop() clears its in-flight queue.
        for (const prompt of this.#queued) this.#dropped(prompt);
        this.#closeMessage();
        this.#turns += 1;
        this.#endedThisRun += 1;
        this.#lastTurnEnd = 'stopped';
        this.#stoppedByYou = by === 'you' && intent === 'stop';
        if (!this.#carryQueue) void this.#emitRow({ kind: 'stopped', n: Math.max(this.#marked, this.#turns), by });
        if (limited) this.#sayStoppedAtLimit();
        const failed = (error: unknown): void => {
            void this.#emitRow({ kind: 'notice', level: 'warning', message: `The turn ended, but Genie could not confirm its processes stopped: ${error instanceof Error ? error.message : String(error)}` });
            this.#changed();
        };
        try {
            void this.stop('SIGTERM', { graceMs: 0 }).then((verdict) => {
                if (!verdict.verified) failed(new Error(`${verdict.reason}${verdict.survivors.length > 0 ? ` Still running: ${describeProcesses(verdict.survivors)}.` : ''}`));
            }).catch(failed);
        } catch (error) { failed(error); }
        this.#changed();
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
     *
     * What was held beside it follows it, in the order it came.
     */
    #closeMessage(): void {
        const open = this.#openMessage;
        this.#openMessage = null;
        this.#enqueue(open);
        if (this.#heldBeside.length === 0) return;
        const held = this.#heldBeside;
        this.#heldBeside = [];
        for (const event of held) void this.#wireRow(event);
    }

    /**
     * WHETHER A ROW ARRIVED BESIDE THE OPEN MESSAGE, rather than after it (genie#1456: one reply drawn as four bubbles, cut
     * mid-word). Only the agent's own next step ends what it is saying. A subagent working in the background and a notice
     * about the session say nothing about that: they land between two deltas of one text block, whenever they happen to.
     * Measured in the ledgers: of 54 mid-word cuts in `tynn`'s, 40 had only a subagent's calls between the pieces and 14
     * only notices, none a call of its own; Codex cut a reply per word on `model/safetyBuffering/updated`.
     *
     * A usage report is not one of these: it is how a provider says a message is over, and on Codex nothing else may
     * separate two of them.
     */
    #besideTheOpen(event: StreamEvent): boolean {
        const subagent = event.kind === 'tool' && event.parentToolCallId !== undefined;
        return this.#openMessage !== null && (subagent || event.kind === 'notice');
    }

    /**
     * WHOSE CALL THIS IS, ON THE ROW ITSELF (genie#1473). The ledger's readers see only rows, and the chat took a subagent's
     * running Bash for the agent's own: a message read at once sat under "Bash 2m" and Interrupt and send, with its reply
     * below it. prism-acp marks a subagent's call and its result; a row of that call that comes without the mark gets it here.
     */
    #markSubagentCall(event: StreamEvent): StreamEvent {
        if (event.kind !== 'tool') return event;
        const parent = event.parentToolCallId ?? this.#subagentCalls.get(event.toolCallId);
        if (parent === undefined) return event;
        if (event.status === 'completed' || event.status === 'failed') this.#subagentCalls.delete(event.toolCallId);
        else this.#subagentCalls.set(event.toolCallId, parent);
        return { ...event, parentToolCallId: parent };
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
        void this.#record(open.event);
    }

    /**
     * Write ONE row to the thread, on the chain, so rows land in the order they were emitted.
     *
     * A row the thread cannot take AT ONCE is not lost (genie#1315). The thread's lock waits 5 s for a holder and then
     * throws `session_locked`; this used to count that and move on, and the row was gone from the agent's history for good
     * — measured on genie-test-windows with the real store: a lock held past one write's wait cost the first turn's
     * marker. A held lock clears (its holder finishes, or its TTL runs out and the next waiter reclaims it), and so does
     * Windows' EPERM/EBUSY/EACCES on a file another process has open (prism-harness reads the same three as "held"). So
     * such a write is tried again after `WRITE_RETRY_MS`, bounded, still in order. Any other fault is final at once.
     *
     * A rejected write never breaks the chain: the next write runs whether this one failed or not. A row that still
     * cannot be saved is counted (`unpersistedEvents`) AND said in the ledger, once per run (`#sayNotSaved`).
     */
    /** `whole`: a tool's output that did not fit its row's preview, kept beside the ledger first (Tynn story #386). */
    #record(event: StreamEvent, whole: string | null = null, images: readonly KeptImage[] = []): Promise<void> {
        this.#pendingRows.push({ event, whole, images });
        // A write already waiting on the chain takes this row too; otherwise one is chained for it.
        if (this.#pendingWrite !== null) return this.#pendingWrite;
        const write = async (): Promise<void> => {
            this.#pendingWrite = null;
            const rows = this.#pendingRows;
            this.#pendingRows = [];
            for (let at = 0; at < rows.length;) {
                // Bounded batches: a burst of large rows is never one giant append.
                let end = at, bytes = 0;
                while (end < rows.length && (end === at || (end - at < WRITE_BATCH_ROWS && bytes < WRITE_BATCH_BYTES))) {
                    bytes += utf8Bytes(JSON.stringify(rows[end]!.event) ?? '');
                    end += 1;
                }
                await this.#writeBatch(rows.slice(at, end));
                at = end;
            }
        };
        const chained = this.#writes.then(write, write);
        this.#pendingWrite = chained;
        this.#writes = chained;
        return chained;
    }

    /** One batch of rows to the thread, in order, as ONE record — retried as a row was (genie#1315). */
    async #writeBatch(rows: ReadonlyArray<{ event: StreamEvent; whole: string | null; images: readonly KeptImage[] }>): Promise<void> {
        const store = this.#options.store;
        for (const { event, whole, images } of rows) {
            // Before the row that names them, as a tool's whole output is. An image that cannot be kept leaves the row: its
            // pill then says the image was not kept, and the conversation is still saved.
            if (images.length > 0 && store instanceof ThreadStore) {
                for (const image of images) {
                    try { await store.writeAttachment(threadKeyFor(this.agentId), image.id, image.mimeType, image.data); } catch { /* the name stands */ }
                }
            }
            if (whole !== null && event.kind === 'tool' && store instanceof ThreadStore) {
                // Before the row that names it. A sidecar that cannot be written leaves the row and its preview: the
                // whole is then "not kept" when a person opens it, and the conversation is still saved.
                try { await store.writeToolOutput(threadKeyFor(this.agentId), event.toolCallId, whole); } catch { /* the preview stands */ }
            }
        }
        for (let attempt = 0; ; attempt += 1) {
            try {
                const thread = openAgentThread(store, this.agentId);
                await thread.record(rows.map(({ event }) => persistable(event, this.#options.runId)));
                return;
            } catch (error) {
                const wait = WRITE_RETRY_MS[attempt];
                if (wait !== undefined && clearsOnItsOwn(error)) {
                    await new Promise((r) => setTimeout(r, wait));
                    continue;
                }
                this.#unpersisted += rows.length;
                this.#sayNotSaved(error);
                return;
            }
        }
    }

    /**
     * A ROW THAT COULD NOT BE SAVED IS SAID, not only counted: nothing read `unpersistedEvents`, so a conversation whose
     * history had stopped being written looked exactly like one being kept. One notice per run, in the ledger only — it
     * is about the thread, so it cannot be written to it.
     */
    #sayNotSaved(error: unknown): void {
        if (this.#notSavedSaid) return;
        this.#notSavedSaid = true;
        const reason = error instanceof Error ? error.message : String(error);
        this.#options.onEvent?.({ kind: 'notice', level: 'error', message: `This conversation is not being saved: a row could not be written to its history (${reason}). What is shown now may be missing after a restart.` }, { replacesLast: false });
        this.#changed();
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
        // THE MCP SERVERS IT CAME UP WITH (genie#1202): reported before anything awaits, like the limit below.
        if (typeof meta === 'object' && meta !== null) {
            const servers = mcpReportsFromMeta(meta as Record<string, unknown>);
            if (servers !== null && servers.length > 0) this.#options.onMcpServers?.(servers);
        }
        if (typeof meta === 'object' && meta !== null && RATE_LIMIT_META in meta) {
            const raw = (meta as Record<string, unknown>)[RATE_LIMIT_META];
            const room = headroomFromMeta(raw);
            if (room) { this.#latestHeadroom = room; this.#options.onHeadroom?.(room); }
            const readings = limitReadingsFromMeta(raw);
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

        // SAVED HISTORY, REPLAYED (genie#1249): Genie already holds it, so it is not recorded again. Known by prism-acp's
        // mark (0.31.0 `META_REPLAY`), never by when it arrives: until 0.31.0 the replay was unmarked and Genie dropped
        // what came before `ready` on a resumed Codex session — which also dropped a LIVE notification arriving
        // mid-replay. Genie resumes Codex with `replayHistory: false` (session-host `codexOptionsFor`), so normally no
        // replay comes at all; one that does is said ONCE, from its summary (a resumed miapa had written 16 compaction
        // dividers and 3,036 `replayed reasoning item had no summary` notices, on every restart).
        const replay = replayOf(update);
        if (replay !== null) {
            if (replay.summary !== null) void this.#emitRow({ kind: 'notice', level: 'debug', message: replay.summary, headroom: null, model: null, estimate: null });
            return;
        }

        const read = toStreamEvent(update);
        if (!read) return; // Deliberately not a ledger row (e.g. the slash-command menu).
        const event = this.#markSubagentCall(read);

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
        //
        // BEFORE ANY TURN OF THIS RUN has ended (a session only started reads idle now, not working), activity is shown as
        // working and opens no marker — what a started session always did: no turn is numbered that Genie cannot place.
        const activity = event.kind === 'think' || event.kind === 'tool' || (event.kind === 'message' && event.speaker === 'agent');
        // Not announced here: this frame's own row (a reply, a thought, a tool call — every one of them a row, emitted
        // below in this same call) is pushed and already reads `working`. Announcing it as well was a second push per
        // first frame (genie#1418, batch B: session-host.test's push count).
        // Activity during Cooling is a turn of the agent's own: Working, and the timer goes.
        if (this.#turnState === 'idle' && activity) this.#stopCooling();
        if (this.#turnState === 'idle' && activity && this.#lastTurnEnd === null) {
            this.#turnState = 'working';
        } else if (this.#turnState === 'idle' && activity) {
            // A prompt queued while the last turn ran is credited to this one (it ran as its own turn); none = nobody's.
            void this.#emitRow({ kind: 'turn', n: this.#nextTurn(), by: this.#queued.shift()?.by ?? null });
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

        if (this.#besideTheOpen(event)) {
            this.#heldBeside.push(event);
            return;
        }

        if (event.kind === 'think') {
            const open = this.#openMessage;
            if (open && open.event.kind === 'think') {
                // The provider's estimate is cumulative for the thought: the newest one stands; a chunk without one keeps it.
                open.event = { ...open.event, text: open.event.text + event.text, estimate: event.estimate ?? open.event.estimate ?? null };
                this.#options.onEvent?.(open.event, { replacesLast: true });
                return; // Written to the thread once, when it closes.
            }
            this.#closeMessage();
            this.#openMessage = { event, persisted: false };
            this.#options.onEvent?.(event, { replacesLast: false });
            return;
        }

        if (event.kind === 'message') {
            const open = this.#openMessage;
            const messageId = typeof update['messageId'] === 'string' ? update['messageId'] : null;
            const sameItem = !open?.messageId || messageId === null || open.messageId === messageId;
            if (open && open.event.kind === 'message' && open.event.speaker === event.speaker && open.event.peerName === event.peerName && sameItem) {
                open.event = { ...open.event, text: open.event.text + event.text };
                this.#options.onEvent?.(open.event, { replacesLast: true });
                return; // Written to the thread once, when it closes.
            }

            // A different speaker: the previous message is finished, and must reach the thread
            // before this one does.
            this.#closeMessage();
            this.#openMessage = { event, persisted: false, messageId };
            this.#options.onEvent?.(event, { replacesLast: false });
            return;
        }

        /*
         * Anything else not beside it (`#besideTheOpen`) CLOSES the open message.
         *
         * A reply, a tool call, then more reply is three rows in that order — which is the
         * point of a ledger. Joining across the tool call would reorder the account of what
         * happened, and the queue is what keeps the tool call from being written before the
         * words that preceded it.
         */
        await this.#wireRow(event);
    }

    /** A row off the wire that is not a message chunk, arriving now or held until now: emitted, and what it says acted on. */
    #wireRow(event: StreamEvent): Promise<void> {
        const written = this.#emitRow(event);
        // REFUSED FOR WANT OF /design-login (#1081): said ONCE per login, after the refused call, however many calls fail.
        if (!this.#designLogin && designLoginRefused(event)) {
            this.#designLogin = true;
            void this.#emitRow({ kind: 'notice', level: 'warning', message: 'Claude Design needs its login on this machine, which an agent session cannot run. Use "Log in to Claude Design" above; Genie tells this agent to retry once it has run.' });
            this.#changed();
        }
        return written;
    }

    /**
     * THE IMAGES A MESSAGE SENDS, KEPT (Tynn #642): one id each, for the row to name and the store to keep them under. The
     * blocks after the message's own text are its attachments, in order, so each image block is matched to its name. A store
     * that keeps no files beside its log (a test's memory store) keeps none, and the row names none.
     */
    #keptImages(sent: { content: readonly PromptBlock[]; attachments: readonly string[] } | null): { refs: readonly AttachmentRef[]; files: readonly KeptImage[] } {
        if (!sent || sent.attachments.length === 0 || !(this.#options.store instanceof ThreadStore)) return { refs: [], files: [] };
        const blocks = sent.content.length > sent.attachments.length ? sent.content.slice(sent.content.length - sent.attachments.length) : sent.content;
        const refs: AttachmentRef[] = [], files: KeptImage[] = [];
        blocks.forEach((block, i) => {
            if (block.type !== 'image') return;
            const id = randomUUID().replace(/-/g, '');
            const name = sent.attachments[i] ?? 'image';
            refs.push({ id, name, mimeType: block.mimeType, bytes: Buffer.byteLength(block.data, 'base64') });
            files.push({ id, mimeType: block.mimeType, data: block.data });
        });
        return { refs, files };
    }

    /**
     * One row that is not a message chunk — from the wire or minted here (a turn marker): closes the open message,
     * reaches the renderer synchronously, and is written to the thread after the message it closed.
     */
    async #emitRow(raw: StreamEvent, images: readonly KeptImage[] = []): Promise<void> {
        this.#closeMessage();

        /*
         * BOUNDED BEFORE ANYONE HOLDS IT (Tynn story #386): a tool row carries at most a 16 KB preview of its input and
         * output, and an unfinished call none — in this session's rows, the window's, and the ledger. The whole output
         * goes in a sidecar the row names, read only when a person opens the row. A store that keeps no files beside
         * its log (a test's memory store) keeps the preview alone.
         */
        const { event, whole } = boundToolEvent(raw, { sidecar: this.#options.store instanceof ThreadStore });
        this.#options.onEvent?.(event, { replacesLast: false });

        // ON THE SAME CHAIN as the message writes: waiting for the chain and then writing outside it let two rows
        // emitted together (a turn marker and your message) reach the thread in either order. A storage fault must not
        // take the turn down with it — and must not vanish either (`#record`).
        await this.#record(event, whole, images);
    }
}

/** An image a message sent, to be kept under the id its row names (Tynn #642). */
interface KeptImage { readonly id: string; readonly mimeType: string; readonly data: string }

/**
 * Why a command did not run, in words: prism-acp's `CommandUnsupported` carries a fixed `reason`
 * (`native_method_missing` → "native method missing"); anything else, its message.
 */
function commandRefusalWords(error: unknown): string {
    const reason = typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'command_unsupported' ? (error as { reason?: unknown }).reason : undefined;
    if (typeof reason === 'string' && reason !== '') return reason.replace(/_/g, ' ');
    return error instanceof Error && error.message !== '' ? error.message : 'the provider refused it';
}

/** What a prompt's ledger row carries beyond its text: a Genie notice's mail (beta.33 item 18). */
export interface PromptContext {
    readonly mail?: readonly NoticeMail[] | undefined;
    /**
     * Its sender tells it again on its own if it does not go (the inbox push, from its book): held and left undelivered,
     * it is discarded, never kept as a draft the next Restart owes (`#leaveQueuedAsDrafts`). Never written to the row.
     */
    readonly retold?: boolean | undefined;
}

/**
 * A prompt's own message row: yours (`you`, or nobody said), or the sender's as a peer — with its files, and, for a
 * Genie notice, the mail it told about. Absent fields are left off, never written empty.
 */
/**
 * A REPLAYED UPDATE (genie#1249), by prism-acp's mark (`REPLAY_META`): `null` when the update is not history. `summary` is
 * the one sentence Genie says for the whole replay, from the summary notice that ends it (`REPLAY_SUMMARY_META`); every
 * other replayed update says nothing.
 */
function replayOf(update: Record<string, unknown>): { summary: string | null } | null {
    const meta = update['_meta'];
    if (typeof meta !== 'object' || meta === null || (meta as Record<string, unknown>)[REPLAY_META] !== true) return null;
    const s = (meta as Record<string, unknown>)[REPLAY_SUMMARY_META];
    if (typeof s !== 'object' || s === null) return { summary: null };
    const { turns, items, complete } = s as { turns?: unknown; items?: unknown; complete?: unknown };
    const count = (n: unknown, one: string) => `${typeof n === 'number' ? n : '?'} ${one}${n === 1 ? '' : 's'}`;
    const ended = complete === false ? '; it stopped before the end' : '';
    return { summary: `Resumed the thread: the provider replayed ${count(turns, 'turn')} (${count(items, 'item')}) of its history${ended}; not recorded again (already in this history).` };
}

function promptRow(text: string, by: string | null, sent: { attachments: readonly string[] } | null, context: PromptContext, kept: readonly AttachmentRef[] = []): StreamEvent {
    const attachments = sent && sent.attachments.length > 0 ? { attachments: sent.attachments, ...(kept.length > 0 ? { attachmentRefs: kept } : {}) } : {};
    const mail = context.mail && context.mail.length > 0 ? { mail: context.mail } : {};
    return by === null || by === 'you'
        ? { kind: 'message', speaker: 'you', peerName: null, text, ...attachments }
        : { kind: 'message', speaker: 'peer', peerName: by, text, ...attachments, ...mail };
}

/**
 * The waits before a thread write is tried again (`AgentSession.#record`): three retries, four attempts in all. Each
 * attempt on a held lock already waits 5 s inside the store; the lock's own TTL is 10 s, so a lock left by a write cut
 * off mid-way is reclaimed by the second attempt. Bounded, so a store that never frees costs a row ~20 s, not forever.
 */
const WRITE_RETRY_MS: readonly number[] = [250, 1000, 2000];
/** The most rows, and about the most bytes, one thread write takes at once (Tynn #550). */
const WRITE_BATCH_ROWS = 256;
const WRITE_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * A thread write fault that CLEARS ON ITS OWN: the lock was held (`session_locked`, prism-harness), or Windows refused a
 * file another process has open (EPERM/EBUSY/EACCES — the three prism-harness's own lock reads as "held"). Anything else
 * (a folder gone, a disk full, a payload it cannot write) is not waited out.
 */
function clearsOnItsOwn(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return code === 'session_locked' || code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
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

/**
 * A request answered by a decision: the option whose ACP `kind` is exactly `allow_once` or `reject_once` (matched as
 * `approvalFrom` matches tone — on the protocol's kind, never a label). Allow with no allow_once offered is NOT allowed
 * by some other option: it is refused. Refusal with no reject_once offered is a cancel, which the provider reads as no.
 */
function answerFor(request: PermissionRequestLike, decision: 'allow' | 'deny'): PermissionOutcomeLike {
    const idOf = (kind: string): string | null => {
        for (const raw of request.options) {
            const id = raw['optionId'];
            if (raw['kind'] === kind && typeof id === 'string' && id.length > 0) return id;
        }
        return null;
    };
    const chosen = (decision === 'allow' ? idOf('allow_once') : null) ?? idOf('reject_once');
    return chosen ? { outcome: 'selected', optionId: chosen } : { outcome: 'cancelled' };
}

/** prism-acp 0.37.0's `ClaudeDriver.prompt()` after an uncertain cancel: `ClaudeCancelStateError`, known by its code. */
function cancelStateUncertain(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === CANCEL_STATE_UNCERTAIN_CODE;
}
