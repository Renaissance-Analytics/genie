import type { McpServer } from '@particle-academy/prism-acp';
import type { SessionStore } from '@particle-academy/prism-harness';
import { LiveReadings } from '../core/live-readings.js';
import { agentActionOf, type AgentActionKind } from '../core/agent-actions.js';
import { RateLimitGate, type GateView, type LimitReading } from '../core/rate-limit-gate.js';
import type { Comms } from '../core/comms.js';
import { statSync } from 'node:fs';
import { CLAUDE_DRIVER_CAPABILITIES, CODEX_DRIVER_CAPABILITIES, ClaudeDriver, CodexDriver } from '@particle-academy/prism-acp';

/**
 * Whether an agent can ask for approval — the DRIVER's published claim (`permissionRequests`), read from prism-acp's
 * declaration rather than branched on a name; except that a Claude agent set to `ask` DOES ask: its shell commands
 * raise `onRequestPermission` through prism-acp's `permissionPrompts` (see `claudeOptionsFor`). `null` for a provider
 * Genie has no driver for: unknown is not "no".
 */
/**
 * What an agent's provider takes in a prompt beyond text, from its driver's DECLARED `promptBlocks` (prism-acp).
 * A driver that declares nothing takes nothing more — and the composer says so rather than dropping the file.
 */
export function promptAcceptsFor(provider: string): PromptAccepts {
    const caps = provider === 'claude' ? CLAUDE_DRIVER_CAPABILITIES : provider === 'codex' ? CODEX_DRIVER_CAPABILITIES : null;
    const blocks = (caps as { promptBlocks?: readonly string[] } | null)?.promptBlocks ?? [];
    return { image: blocks.includes('image'), textResource: blocks.includes('resource-text') };
}

/**
 * Whether an agent's driver can END A TURN and keep the session, from its driver's DECLARED `cancel` (prism-acp
 * `DriverCapabilities.cancel`, 0.14.0: `true` for Claude and Codex). `null` when the driver declares nothing (an older
 * prism-acp) or Genie has no driver for the provider: unknown is not "yes", and no turn Stop is offered on it.
 * Read through a record because the field is newer than the types an older prism-acp ships.
 */
export function turnCancelFor(provider: string): boolean | null {
    const caps = provider === 'claude' ? CLAUDE_DRIVER_CAPABILITIES : provider === 'codex' ? CODEX_DRIVER_CAPABILITIES : null;
    const declared = caps === null ? undefined : (caps as Readonly<Record<string, unknown>>)['cancel'];
    return typeof declared === 'boolean' ? declared : null;
}

/** The most recent recorded rows the Agent view loads; older ones are counted, not shown. */
export const HISTORY_LIMIT = 3000;

export function raisesApprovals(provider: string, permissions?: AgentPermissions): boolean | null {
    if (provider === 'claude') return permissions === 'ask' ? true : CLAUDE_DRIVER_CAPABILITIES.permissionRequests;
    if (provider === 'codex') return CODEX_DRIVER_CAPABILITIES.permissionRequests;
    return null;
}
import { threadIdIsResumable, type AgentId, type AgentPermissions, type AgentRecord } from '../core/identity.js';
import { promptContent, type Attachment, type PromptAccepts } from '../core/prompt-content.js';
import type { LiveSession } from '../core/roster.js';
import type { ProcessTree } from '../core/process-tree.js';
import {
    AgentSession,
    type DriverEvents,
    type PermissionOutcomeLike,
    type CancelOutcome,
    type PermissionRequestLike,
    type PromptContext,
    type SessionDriverFactory,
    type TurnOutcomeLike,
} from '../core/session.js';
import type { StreamEvent } from '../core/stream-event.js';
import type { TimedEvent } from '../core/stream-view.js';
import { openDurableStore, readHistory } from '../core/thread-store.js';
import { lastNumberedTurn, numberRow, numberTurns } from '../core/turn-numbers.js';
import { sessionsDir } from './paths.js';

/**
 * THE RUNNING AGENTS — one place that owns sessions, and counts them.
 *
 * ## There is no pty in this file and there is no engine decision to make
 *
 * `AgentEngine` has one member, `'acp'`, so "an agent on a pty" does not typecheck. What the
 * previous build got wrong was not the decision but the ORDER: `createAgentTerminal` spawned a
 * pty unconditionally about seventy lines *before* anything decided an engine, so removing the
 * pty engine changed nothing a user could see — agents still held ptys and still read
 * `claude · pty` on screen.
 *
 * Here the only thing that can be spawned is a provider driver, and the only way to get one is
 * `driverFor`, which returns `null` for a provider it cannot run. **`null` means cannot run as
 * an agent — never "fall back to a terminal".**
 *
 * ## Capacity is the size of this map
 *
 * Never a process scan, never `ptys.length`. The previous build counted ptys, which is why
 * removing ptys from agents broke fifty-two tests: fifty-two places had agreed that an agent's
 * existence was a terminal's existence.
 */

/** Injected so a test can run this host without spawning a provider CLI. */
/** `extras.mcpServers`: the MCP servers this session starts with (Genie's own, with the agent's caller key). */
export type DriverFor = (record: AgentRecord, cwd: string, resumeSessionId: string | null, extras?: { mcpServers?: readonly McpServer[]; serviceEnv?: Readonly<Record<string, string>> }) => SessionDriverFactory | null;

/**
 * THE AGENT'S SERVICE VARIABLES, AS PRISM-ACP TAKES THEM (the owner, 2026-10-16: "ONLY let through Genie-managed
 * service. DO NOT EXPOSE KEYS"). The workspace's managed-service env over Genie's own, and an allow-list of exactly
 * its names: prism-acp builds the child's env allow-list-first (`childEnv`), so these names — and its own base set —
 * reach the agent, and nothing else Genie's environment holds does. None = no options, the provider's default.
 */
export function serviceEnvDriverOptions(serviceEnv: Readonly<Record<string, string>>): { parentEnv?: Readonly<Record<string, string | undefined>>; allowEnv?: readonly string[] } {
    const names = Object.keys(serviceEnv);
    if (names.length === 0) return {};
    return { parentEnv: { ...process.env, ...serviceEnv }, allowEnv: names };
}

/**
 * The real factory: one driver per provider, and `null` for anything else.
 *
 * `null` is a refusal. An agent whose provider Genie cannot drive does not get a terminal as a
 * consolation prize; it stays registered, idle, and reports what is missing.
 */
/**
 * Which binary to run for a provider, or `undefined` for its default.
 *
 * **Configuration, not a test hook**, and the distinction is the one the previous build got
 * wrong. Its `GENIE_E2E` variable CHANGED BEHAVIOUR — it short-circuited the single-instance
 * lock — so the suite exercised an application that behaved differently from the shipped one,
 * and the measured result was two instances opening windows on the owner's desktop while real
 * agents were mid-turn.
 *
 * A path changes nothing about how Genie behaves. It is the same need a user with an nvm
 * install, a pinned version, or a provider outside `PATH` has.
 *
 * One variable per provider: reading a single one for both would mean Genie launching claude
 * and getting codex, which fails in a way that names neither the variable nor the cause. An
 * EMPTY value is treated as unset, because `GENIE2_CLAUDE_BINARY=` in a shell profile is how
 * somebody un-sets it, and passing `""` through would spawn nothing with an opaque error.
 */
export function providerBinary(
    provider: string,
    env: Record<string, string | undefined> = process.env,
): string | undefined {
    const configured = env[`GENIE2_${provider.toUpperCase()}_BINARY`];
    const trimmed = configured?.trim();
    return trimmed ? trimmed : undefined;
}

/**
 * The session's events, in the shape `prism-acp` drivers take.
 *
 * **One forwarder, used by every provider**, and that is the whole point of extracting it.
 *
 * `onRequestPermission` was missing from both inline versions of this. The approval feature was
 * built and unit-tested at every layer — the narrowing, the session's promise handling, the
 * host, the bridge, the UI, the one-place-only rule — and it was **unreachable in the running
 * application**, because the line that hands the handler to the provider did not exist.
 *
 * Every test passed, because every test drove `AgentSession` directly with a fake driver that
 * called `events.onRequestPermission` itself. Nothing exercised the real wiring. That is §0.4
 * exactly: a finished feature behind a missing connection, with a green suite.
 *
 * Two drivers each spelling this out separately is how one of them ends up a handler short.
 * Now there is one place to be wrong, and `test/session-host.test.ts` counts it.
 */
export function driverEvents(events: DriverEvents): {
    onUpdate: (update: unknown) => void;
    onRequestPermission: (request: PermissionRequestLike) => Promise<PermissionOutcomeLike>;
    onTurnEnd: (outcome: TurnOutcomeLike) => void;
    onProtocolError: (problem: string, detail?: { readonly recoverable: boolean }) => void;
    onStderr: (line: string) => void;
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
    return {
        onUpdate: (update) => events.onUpdate?.(update as Record<string, unknown>),
        /**
         * A driver that asks and gets no answer waits forever, so the fallback is a CANCEL
         * rather than a dropped promise. A session with no handler has decided not to take
         * approvals, and telling the provider so is a decision it understands — leaving it
         * pending is an agent frozen on a question nobody will ever see.
         */
        onRequestPermission: (request) =>
            events.onRequestPermission?.(request) ?? Promise.resolve({ outcome: 'cancelled' as const }),
        onTurnEnd: (outcome) => events.onTurnEnd?.(outcome),
        onProtocolError: (problem, detail) => events.onProtocolError?.(problem, detail),
        onStderr: (line) => events.onStderr?.(line),
        onExit: (code, signal) => events.onExit?.(code, signal),
    };
}

/**
 * A Claude agent's driver options: its cwd, its resume, and what it may do without asking. With no permission mode
 * Claude Code refused every tool that needs approval — the owner's agent could not run git, artisan or its tests.
 * - `all` (the default) → `bypassPermissions`: every tool runs.
 * - `ask` → `bypassPermissions` PLUS prism-acp's `permissionPrompts` for `Bash`: every other tool (Genie's MCP tools
 *   included) runs, and a shell command waits for the person — `onRequestPermission`, the same request Codex raises,
 *   answered inline in the chat — and runs only on an explicit allow once. The hook's deny holds under bypass.
 * - `edits` → `acceptEdits`: file edits go through and shell is refused. No prompts.
 * The agent's chosen MODEL rides along (`--model`) when it has one; none = no key, and Claude Code picks its own default.
 */
export function claudeOptionsFor(record: AgentRecord, cwd: string, resumeSessionId: string | null): { cwd: string; resumeSessionId?: string; permissionMode: 'bypassPermissions' | 'acceptEdits'; permissionPrompts?: { readonly tools: readonly string[] }; model?: string } {
    return {
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        permissionMode: record.permissions === 'edits' ? 'acceptEdits' : 'bypassPermissions',
        // BOTH shell tools: Bash, and PowerShell, which Claude Code also has on Windows — gating Bash alone would let a
        // PowerShell command run unasked.
        ...(record.permissions === 'ask' ? { permissionPrompts: { tools: ['Bash', 'PowerShell'] } } : {}),
        ...(record.model ? { model: record.model } : {}),
    };
}

/**
 * A Codex agent's driver options (Tynn #797). Codex asks before an MCP server's tools run, and a session has nobody to
 * answer, so Genie's tools were declined on every call. Genie's OWN server is approved (`default_tools_approval_mode`
 * through prism-acp's `mcpToolApproval`), as a Claude agent already runs them unasked: each Genie tool that acts for the
 * person gates itself. No other server is touched, and with no Genie server there is nothing to approve (prism refuses
 * an approval naming a server it was not given). The chosen model goes on thread/start and thread/resume; none = Codex's own.
 */
export function codexOptionsFor(record: AgentRecord, cwd: string, resumeSessionId: string | null, mcpServers: readonly McpServer[]): { cwd: string; resumeSessionId?: string; model?: string; mcpServers?: readonly McpServer[]; mcpToolApproval?: { genie: 'approve' } } {
    return {
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(record.model ? { model: record.model } : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(mcpServers.some((s) => s.name === 'genie') ? { mcpToolApproval: { genie: 'approve' as const } } : {}),
    };
}

export const realDriverFor: DriverFor = (record, cwd, resumeSessionId, extras) => {
    const resume = resumeSessionId ? { resumeSessionId } : {};
    const mcp = extras?.mcpServers && extras.mcpServers.length > 0 ? { mcpServers: extras.mcpServers } : {};
    // The workspace's managed-service variables, by allow-list (serviceEnvDriverOptions) — nothing else Genie holds.
    const env = serviceEnvDriverOptions(extras?.serviceEnv ?? {});
    const configured = providerBinary(record.provider);
    const binary = configured ? { binary: configured } : {};

    switch (record.provider) {
        case 'claude':
            return (options) => new ClaudeDriver({ ...claudeOptionsFor(record, cwd, resumeSessionId), ...binary, ...mcp, ...env }, driverEvents(options.events));

        case 'codex':
            return (options) => new CodexDriver({ ...codexOptionsFor(record, cwd, resumeSessionId, extras?.mcpServers ?? []), ...binary, ...env }, driverEvents(options.events));

        default:
            return null;
    }
};

interface Running {
    session: AgentSession;
    /** The provider it runs on: whose rate-limit login holds it (Tynn #793). */
    provider: string;
    /** The ledger, with arrival times. Timestamps are recorded HERE because this is where the
     *  event arrives — the wire carries none, and a time invented later would be a guess. */
    rows: TimedEvent[];
    startedAt: number;
    nextRowId: number;
    /** The action keys already sounded (Tynn #766 C): cleared when a turn ends. */
    readonly sounded: Set<string>;
    /** The MCP servers this session was STARTED with, by name — what the Agent view says it has. */
    mcp: readonly string[];
    /** What its provider takes in a prompt beyond text. */
    accepts: PromptAccepts;
    /** Whether this run resumed a conversation (the record's thread id) — what its run marker says. */
    resumed: boolean;
    /** Whether its driver DECLARES a turn cancel (`turnCancelFor`); the session's own driver must also have one. */
    cancelDeclared: boolean;
    /** Which run this is, unique in this host — what tells a restarted agent's session from the one before it. */
    run: number;
    /** What `probe()` reports from the rows, kept as they arrive (core/live-readings.ts) — never read again from all of them. */
    readings: LiveReadings;
    /** The row that says where this run begins, made once: the same object on every read, so the window's patch keeps it. */
    marker: TimedEvent;
    /** This run's rows numbered on from the history's turns (`base`), kept as they arrive; `null` until needed. */
    numbered: { base: number; n: number; rows: TimedEvent[] } | null;
    /** The ledger last served, for the history it was served with: ONE array per run, grown in place as rows arrive (see `rowAdded`); `null` = rebuild it. */
    ledger: { history: object | null; rows: TimedEvent[] } | null;
}

/** A stopped agent's ledger before its history is read: one empty array, so two reads are the same ledger. */
const NO_ROWS: readonly TimedEvent[] = [];

export class SessionHost {
    readonly #userData: string;
    readonly #store: () => SessionStore;
    readonly #driverFor: DriverFor;
    readonly #mcpServersFor: ((record: AgentRecord) => readonly McpServer[]) | undefined;
    readonly #onTurnNumbered: ((agentId: AgentId, n: number) => void) | undefined;
    readonly #onAction: ((agentId: AgentId, kind: AgentActionKind | 'started' | 'replied' | 'limited' | 'resumed') => void) | undefined;
    /** The workspace's managed-service variables now, for a session starting (serviceEnvDriverOptions). Absent = none. */
    readonly #serviceEnvFor: ((workspaceId: string) => Readonly<Record<string, string>>) | undefined;
    readonly #clock: () => number;
    readonly #running = new Map<AgentId, Running>();
    /** Sessions stopped whose writes may still be in flight — what `settled()` waits for besides the running ones. */
    readonly #stopped = new Set<AgentSession>();
    /** Each agent's recorded history, read once per run: `before` is the run it was read for (`null` = not running). */
    readonly #histories = new Map<AgentId, { before: number | null; rows: readonly TimedEvent[]; turns: number } | 'loading'>();
    #listeners = new Set<(agentId: AgentId) => void>();
    #runs = 0;

    /** Why a start was refused, by agent. Reported, never swallowed. */
    readonly refusals = new Map<AgentId, string>();
    /**
     * Session ids the PROVIDER reported and Genie refused to keep, by agent.
     *
     * Not silence. An agent whose id was refused cannot be resumed, which means its
     * conversation will not survive a restart — a real degradation, and one the user has to be
     * able to learn about. Held here rather than painted red: the turn in progress is fine,
     * and failing it would be a worse lie in the other direction.
     *
     * **Surfacing this is not built yet** and is named as an open item rather than quietly
     * dropped. It is recorded, with the value, so it is diagnosable today.
     */
    readonly unusableThreadIds = new Map<AgentId, string>();

    readonly #processTree: ProcessTree | undefined;
    readonly #onThreadId: ((agentId: AgentId, threadId: string) => void) | undefined;
    readonly #comms: ((agentId: AgentId, since: number) => Comms | null) | undefined;
    readonly #heldElsewhere: ((record: AgentRecord) => string | null) | undefined;

    /**
     * `processTree` is INJECTABLE, and that is not a convenience — it is a safety fix.
     *
     * `AgentSession` falls back to the real system process tree, which on Windows shells out
     * to PowerShell to enumerate descendants and then **kills** whatever appeared between
     * start and stop. With the host not passing one, every unit test that started a session
     * was spawning PowerShell and calling `killTree` on live pids — including, potentially, a
     * sibling vitest worker.
     *
     * Found by a flake: one run of `stopAll` failed at 6.5 seconds for a test that does no I/O.
     * The duration was the tell. A flaky test is a test telling you something.
     */
    constructor(options: {
        userData: string;
        driverFor?: DriverFor;
        clock?: () => number;
        processTree?: ProcessTree;
        /**
         * The provider identified its conversation, and it is a value Genie is willing to keep.
         *
         * Called at most once per session, with an id that has already passed
         * `threadIdIsResumable`. The listener's job is to persist it — without one, nothing
         * ever writes a thread id down and every restart begins a new conversation while every
         * test about resume passes.
         */
        onThreadId?: (agentId: AgentId, threadId: string) => void;
        /**
         * The MCP servers an agent's session starts with — Genie's own, carrying that agent's caller key. Late-bound:
         * the MCP server starts after the host. Absent = none.
         */
        mcpServersFor?: (record: AgentRecord) => readonly McpServer[];
        /**
         * A turn STARTED and took its number — main writes it to the record (`lastTurn`) for the next start. At the start,
         * not the end: a turn cut off by an exit or a quit had already taken its number, and the next run numbered it again.
         */
        onTurnNumbered?: (agentId: AgentId, n: number) => void;
        /**
         * WHAT AN AGENT DID (Tynn #766 row C): each action once — started, a reply ended, a tool call by its provider's
         * category, its plan (once a turn), being stopped — and for a whole login, its rate limit and the resume. Main
         * pushes it to the window, which plays the sound the person chose for it.
         */
        onAction?: (agentId: AgentId, kind: AgentActionKind | 'started' | 'replied' | 'limited' | 'resumed') => void;
        serviceEnvFor?: (workspaceId: string) => Readonly<Record<string, string>>;
        /**
         * Who this agent exchanged AgentInbox mail with since `since` (its session start) — the Dashboard's comms
         * cell and the collaborator reveal (core/comms.ts). Late-bound: the inbox exists after the host. Absent or
         * `null` = not measured, and the cell stays blank rather than claiming nobody.
         */
        comms?: (agentId: AgentId, since: number) => Comms | null;
        /**
         * Something else is running an agent in this one's workspace and holds it — doctor mode beside this Genie
         * (core/genie-running.ts). Answers the reason, or `null` when it may start. Absent = nothing holds anything.
         */
        heldElsewhere?: (record: AgentRecord) => string | null;
        /**
         * THE RATE-LIMIT GATE (Tynn #793): one per provider login, fed every session's readings. When it closes, every
         * agent on that provider is held; a timer (`schedule`, no polling) wakes the host at the gate's resume time.
         * Defaults: a 2-minute margin, the real setTimeout.
         */
        rateLimit?: { gate?: RateLimitGate; schedule?: (ms: number, fn: () => void) => () => void };
        /** Where the threads are kept. Default: the durable file store under `userData` — a test may hand in its own. */
        store?: () => SessionStore;
    }) {
        this.#userData = options.userData;
        this.#store = options.store ?? (() => openDurableStore(sessionsDir(this.#userData)));
        this.#driverFor = options.driverFor ?? realDriverFor;
        this.#mcpServersFor = options.mcpServersFor;
        this.#onTurnNumbered = options.onTurnNumbered;
        this.#onAction = options.onAction;
        this.#serviceEnvFor = options.serviceEnvFor;
        this.#clock = options.clock ?? (() => Date.now());
        this.#processTree = options.processTree;
        this.#onThreadId = options.onThreadId;
        this.#comms = options.comms;
        this.#heldElsewhere = options.heldElsewhere;
        this.#gate = options.rateLimit?.gate ?? new RateLimitGate();
        this.#schedule = options.rateLimit?.schedule ?? ((ms, fn) => { const t = setTimeout(fn, Math.max(0, ms)); t.unref?.(); return () => clearTimeout(t); });
    }

    readonly #gate: RateLimitGate;
    readonly #schedule: (ms: number, fn: () => void) => () => void;
    #wakeCancel: (() => void) | null = null;

    /** Every Genie agent of a provider runs on the person's one login of it, so the login IS the provider here. */
    #loginOf(provider: string): { provider: string; account: string } {
        return { provider, account: 'default' };
    }

    /** A session's readings: the gate decides; a closed login holds every agent on it, and the wake is (re)scheduled. */
    #limitReport(provider: string, readings: readonly LimitReading[], message: string | null): void {
        const view = this.#gate.report(this.#loginOf(provider), readings, this.#clock(), message);
        if (view.state !== 'open') this.#holdLogin(provider);
        this.#wake();
    }

    /**
     * A turn the provider ended on its limit with no reading (Tynn #791): the gate holds the login on its stated
     * backoff — there is no reset to wait for — and every agent on it is held.
     */
    #limitBreach(provider: string, reason: string): void {
        this.#gate.breach(this.#loginOf(provider), this.#clock(), `The provider ended a turn on its rate limit (${reason}).`);
        this.#holdLogin(provider);
        this.#wake();
    }

    #holdLogin(provider: string): void {
        let first: AgentId | null = null;
        for (const [id, entry] of this.#running) {
            if (entry.provider === provider && !entry.session.held) { entry.session.hold(); this.#emit(id); first ??= id; }
        }
        // ONCE for the login, not once per agent it holds: one limit, one sound.
        if (first !== null) this.#onAction?.(first, 'limited');
    }

    /** Resume the logins whose hold has ended, and schedule the next wake at the earliest resume still ahead. */
    #wake(): void {
        this.#wakeCancel?.();
        this.#wakeCancel = null;
        const now = this.#clock();
        for (const key of this.#gate.due(now)) this.#resumeHeld(key.provider);
        let next = Infinity;
        for (const provider of new Set([...this.#running.values()].map((e) => e.provider))) {
            const v = this.#gate.view(this.#loginOf(provider), now);
            if (v.state === 'paused') next = Math.min(next, v.resumeAtMs);
            else if (v.state === 'retrying') next = Math.min(next, v.nextTryAtMs);
        }
        if (next !== Infinity) this.#wakeCancel = this.#schedule(next - now, () => this.#wake());
    }

    #resumeHeld(provider: string): void {
        let first: AgentId | null = null;
        for (const [id, entry] of this.#running) {
            if (entry.provider === provider && entry.session.held) { entry.session.resumeAfterLimit(); this.#emit(id); first ??= id; }
        }
        if (first !== null) this.#onAction?.(first, 'resumed');
    }

    /** The provider logins the gate holds now, among the running agents — one per login, however many it holds (Tynn #794: the tray). */
    heldLogins(): Array<{ provider: string; view: GateView }> {
        const now = this.#clock();
        const out: Array<{ provider: string; view: GateView }> = [];
        for (const provider of new Set([...this.#running.values()].map((e) => e.provider))) {
            const view = this.#gate.view(this.#loginOf(provider), now);
            if (view.state !== 'open') out.push({ provider, view });
        }
        return out;
    }

    /** The providers whose login signed out at least one running agent, once each (the tray names them). */
    signedOutProviders(): string[] {
        return [...new Set([...this.#running.values()].filter((e) => e.session.signedOut).map((e) => e.provider))].sort();
    }

    /** The running agents a provider's login signed out — brought back once the person has signed in again. */
    signedOutAgents(provider: string): AgentId[] {
        return [...this.#running].filter(([, e]) => e.provider === provider && e.session.signedOut).map(([id]) => id);
    }

    /** The person's "Resume now" for a provider's login: open at once, its held agents go on. */
    resumeLimit(provider: string): void {
        this.#gate.resumeNow(this.#loginOf(provider));
        this.#resumeHeld(provider);
        this.#wake();
    }

    /** Live sessions. The ONLY correct source for "how many agents are running". */
    get count(): number {
        return this.#running.size;
    }

    /** Which agents have a live session — what this Genie publishes for doctor mode (core/genie-running.ts). */
    startedIds(): AgentId[] {
        return [...this.#running.keys()];
    }

    subscribe(listener: (agentId: AgentId) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Start, or REATTACH.
     *
     * Starting an agent that is already running returns the same session rather than creating
     * a second. §6.2 is explicit about it, and the alternative is two provider processes
     * answering as one agent — which is how a user ends up unable to stop something.
     */
    start(record: AgentRecord, cwd: string): { ok: true } | { ok: false; reason: string } {
        const existing = this.#running.get(record.id);
        if (existing) return { ok: true };

        // Two processes driving one workspace's agents is how a conversation forks: a hold is a refusal, said.
        const held = this.#heldElsewhere?.(record) ?? null;
        if (held !== null) return { ok: false, reason: held };

        const mcpServers = this.#mcpServersFor?.(record) ?? [];
        const serviceEnv = this.#serviceEnvFor?.(record.workspaceId) ?? {};
        const driverFactory = this.#driverFor(record, cwd, record.threadId, { mcpServers, serviceEnv });
        if (!driverFactory) {
            const reason = `Genie cannot run a "${record.provider}" agent. It stays registered and idle.`;
            this.refusals.set(record.id, reason);
            this.#emit(record.id);
            return { ok: false, reason };
        }

        /**
         * THE WORKSPACE FOLDER, checked before anything is spawned.
         *
         * Genie knows this path. A provider handed a directory that is not there fails inside
         * its own spawn, and what comes back is the provider's sentence about itself —
         * measured, from prism-acp: `failed to spawn Codex (Error)`.
         *
         * That sentence is true and it points at the wrong component. It cost this build a
         * wrong diagnosis, a commit blaming a library that handles its own case correctly, and
         * a CI exception written with the wrong reason in it. The cause was a folder that had
         * been moved.
         *
         * `statSync` rather than `existsSync`, because a repo entry pointing at `project.json`
         * instead of its directory is an ordinary typo and `existsSync` waves it straight
         * through to the same opaque failure.
         *
         * This is a refusal, not a fault: the agent stays registered and idle, nothing is
         * consumed, and the reason names the path so the repair is obvious. §6.2 — diagnose
         * names a CAUSE and the repair that fits.
         */
        /**
         * A STORED thread id, before it is handed to a provider as a command-line argument.
         *
         * The other end of `threadIdIsResumable`. This file is editable by anything running as
         * the user, so a value in it is trusted today purely because Genie wrote it — and on
         * Windows prism-acp must spawn with `shell: true`, where cmd.exe interprets `&`, `|`
         * and `&&` **inside arguments**.
         *
         * A refusal rather than a quiet fresh start: §6.2 says a graceful resume that cannot
         * happen refuses instead of silently opening a new chat, because a new conversation
         * presented as a resumed one is how a day of context disappears with no message.
         */
        if (record.threadId && !threadIdIsResumable(record.threadId)) {
            const reason =
                `Genie will not resume "${record.name}": the stored thread id is not a value it ` +
                `is willing to pass to a provider — "${record.threadId}". Restart it fresh to ` +
                `start a new conversation.`;
            this.refusals.set(record.id, reason);
            this.#emit(record.id);
            return { ok: false, reason };
        }

        const folder = statSync(cwd, { throwIfNoEntry: false });
        if (!folder?.isDirectory()) {
            const reason = folder
                ? `Genie cannot run an agent in "${cwd}" — that is a file, not a folder.`
                : `Genie cannot run an agent in "${cwd}" — the folder is not there. It stays registered and idle.`;
            this.refusals.set(record.id, reason);
            this.#emit(record.id);
            return { ok: false, reason };
        }

        this.refusals.delete(record.id);

        const rows: TimedEvent[] = [];
        const startedAt = this.#clock();
        const entry: Running = { session: null as unknown as AgentSession, provider: record.provider, rows, startedAt, nextRowId: 0, sounded: new Set<string>(), mcp: mcpServers.map((s) => s.name), accepts: promptAcceptsFor(record.provider), resumed: Boolean(record.threadId), cancelDeclared: turnCancelFor(record.provider) === true, run: ++this.#runs, readings: new LiveReadings(), marker: { id: `${record.id}:run`, event: { kind: 'run', resumed: Boolean(record.threadId) }, at: startedAt }, numbered: null, ledger: null };

        let reportedTurns = record.lastTurn ?? 0;
        let numberedTurn = record.lastTurn ?? 0;
        const session: AgentSession = new AgentSession({
            agentId: record.id,
            cwd,
            store: this.#store(),
            driverFactory,
            clock: () => this.#clock(),
            ...(record.threadId ? { resumeSessionId: record.threadId } : {}),
            ...(this.#processTree ? { processTree: this.#processTree } : {}),
            // Its turns so far, known at start: the first turn after a relaunch numbers on at once (identity.ts lastTurn).
            ...(record.lastTurn !== undefined ? { turnsBefore: record.lastTurn } : {}),
            onRateLimit: (readings, message) => this.#limitReport(record.provider, readings, message),
            onLimitBreach: (reason) => this.#limitBreach(record.provider, reason),
            /*
             * A change the UI renders — a parked approval, an answered one, a turn ending.
             *
             * Without this the renderer learned about an approval only when the NEXT ledger row
             * happened to arrive, and a blocked agent produces no further rows by definition.
             */
            onStateChange: () => {
                // A turn that ended: once per turn.
                const turns = session.turns;
                if (turns > reportedTurns) {
                    reportedTurns = turns;
                    // A REPLY that ended — not a failed, stopped or held turn; and the plan sounds again next turn.
                    if (session.lastTurnEnd === 'replied') this.#onAction?.(record.id, 'replied');
                    entry.sounded.clear();
                }
                this.#emit(record.id);
            },
            /*
             * The provider's own id, guarded at the EARLIEST point Genie controls it.
             *
             * It arrives from the provider — prism-acp's only check is `typeof === 'string'` —
             * so it is untrusted here, not merely when it is read back off disk. Guarding on
             * read alone would defend against a tampered file and not against the party that
             * chose the string.
             */
            onSessionId: (threadId) => {
                if (!threadIdIsResumable(threadId)) {
                    this.unusableThreadIds.set(record.id, threadId);
                    return;
                }
                this.#onThreadId?.(record.id, threadId);
            },
            onEvent: (event: StreamEvent, meta) => {
                // A TURN TOOK ITS NUMBER: kept on the record now, so a turn cut off before it ends is never numbered again.
                if (event.kind === 'turn' && event.n > numberedTurn) {
                    numberedTurn = event.n;
                    this.#onTurnNumbered?.(record.id, event.n);
                }
                /*
                 * `replacesLast` means the SAME message with another chunk of text on the end.
                 *
                 * The row is updated in place rather than appended, and keeps its id and its
                 * arrival time:
                 *
                 *  - **the id**, because a row whose id changed on every chunk would remount on
                 *    every frame, losing a selection, a scroll position and the Inspector's
                 *    subject mid-reply;
                 *  - **the time**, because the ledger's times are arrival times. Re-stamping
                 *    per chunk would report a message as having happened when it FINISHED,
                 *    which moves it in the timeline and drags Lanes with it.
                 *
                 * Without this the host appended every emission, so three chunks became three
                 * rows whose texts were each a longer prefix of the last — the reply repeated
                 * with a growing prefix, which is worse than the fragments it replaced. The
                 * session-level test asserted the FLAG was sent and passed the whole time; only
                 * a row COUNT could have caught it.
                 */
                // What the agent did, sounded ONCE per key (a tool call's many updates; a plan's rewrites in a turn).
                const action = agentActionOf(event);
                if (action && !entry.sounded.has(action.key)) { entry.sounded.add(action.key); this.#onAction?.(record.id, action.kind); }
                const last = rows.at(-1);
                if (meta?.replacesLast && last) {
                    rows[rows.length - 1] = { ...last, event };
                    rowReplaced(entry, last.event);
                } else {
                    rows.push({ id: `${record.id}:${entry.nextRowId++}`, event, at: this.#clock() });
                    rowAdded(entry);
                }
                this.#emit(record.id);
            },
        });

        entry.session = session;
        this.#running.set(record.id, entry);

        /**
         * A provider can fail to spawn SYNCHRONOUSLY, and that path reaches none of the
         * driver's event handlers.
         *
         * Because the throw happens inside `start()` it never becomes an `onExit` or an
         * `onProtocolError`, and the renderer calls `openAgent` through
         * `void ipcRenderer.invoke(...)`, which swallows a rejection. Without this the click
         * would do **nothing at all, silently** — no red row, no message, no console error.
         * The same silent-failure class as the dropped `onProtocolError`, by a different door.
         *
         * The half-started session is removed rather than left in the map: capacity consumed
         * by nothing, and a row that reads as running when no process exists.
         *
         * ## What this is NOT, because the first version of this comment said it was
         *
         * I measured `spawn('…/npm/codex.cmd', ['app-server', …])` throwing EINVAL on Windows —
         * npm installs CLIs as `.cmd` shims and Node refuses to spawn one without
         * `shell: true`, the CVE-2024-27980 fix — and wrote that codex therefore could not run
         * here at all.
         *
         * **That was the wrong call to measure.** prism-acp passes
         * `shell: process.platform === 'win32'` at both of its spawn sites, verified in the
         * installed 0.6.1, so the library never makes the call I reproduced. Through the real
         * driver, codex starts on Windows and reports a session id.
         *
         * The repro copied the binary and the args faithfully and dropped the options object,
         * which is what made it look complete. Reproducing a library's call means reproducing
         * its options too, or going in at the library's own entry point and letting it build
         * the call.
         *
         * So this guard defends a real shape — `child_process.spawn` does throw synchronously,
         * for a bad cwd type, a bad option, a path the OS rejects — and no longer claims to
         * know which provider hits it. The failure it was first aimed at was a missing
         * workspace folder, which is now refused above, by name, before anything spawns.
         */
        try {
            session.start();
            // Its login is at its limit: held from the start, so nothing is sent to a provider that would refuse it.
            if (this.#gate.view(this.#loginOf(record.provider), this.#clock()).state !== 'open') session.hold();
        } catch (error) {
            this.#running.delete(record.id);

            const configured = providerBinary(record.provider);
            const reason = [
                `Genie could not start ${record.provider}: ${String((error as Error).message ?? error)}.`,
                // The configured PATH, when there is one. An error like "spawn EINVAL" names
                // no file, so on its own it sends the reader looking in the wrong place — and
                // a `GENIE2_<PROVIDER>_BINARY` pointing somewhere stale is a cause nothing
                // else in the message would reveal.
                configured ? `Configured binary: ${configured}` : null,
            ]
                .filter(Boolean)
                .join(' ');

            this.refusals.set(record.id, reason);
            this.#emit(record.id);
            return { ok: false, reason };
        }

        this.#emit(record.id);
        // It started (Tynn #766 C): its own sound, if the person chose one.
        this.#onAction?.(record.id, 'started');
        return { ok: true };
    }

    /**
     * Answer a parked approval, with the provider's own option id.
     *
     * Returns false when there was nothing parked or the id was not offered — the session
     * checks, because the renderer is not trusted to send back a valid one.
     */
    answerApproval(agentId: AgentId, optionId: string, note = ''): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;

        // The person's note, when there is one, reaches the agent after the answer (AgentSession.answerApproval, item 16).
        const answered = entry.session.answerApproval(optionId, note);
        if (answered) this.#emit(agentId);
        return answered;
    }

    /** A message that must reach the agent, now or when its turn ends (AgentSession.deliver); false = no session. */
    deliver(agentId: AgentId, text: string, by: string | null = 'you'): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;
        entry.session.deliver(text, by);
        this.#emit(agentId);
        return true;
    }

    /** `by` is who started the turn, when the caller knows (`you`, `genie`, a peer's name); it is written into the ledger. */
    /**
     * Your message WITH files (the composer's attach): sent as prompt content blocks, or refused with the reason —
     * naming the file — when the provider cannot take one. Never sent without the files it was written about.
     */
    promptWith(agentId: AgentId, text: string, attachments: readonly Attachment[], by: string | null = 'you'): { ok: true } | { ok: false; reason: string | null } {
        const entry = this.#running.get(agentId);
        if (!entry) return { ok: false, reason: null };
        if (attachments.length === 0) return this.prompt(agentId, text, by) ? { ok: true } : { ok: false, reason: null };
        const built = promptContent(text, attachments, entry.accepts, (bytes) => Buffer.from(bytes).toString('base64'));
        if (!built.ok) return { ok: false, reason: built.reason };
        entry.session.prompt(text, by, { content: typeof built.content === 'string' ? [{ type: 'text', text: built.content }] : built.content, attachments: built.names });
        this.#emit(agentId);
        return { ok: true };
    }

    /**
     * The agent's RUN when its session can take a turn now (`AgentSession.promptable`), else `null` — not running,
     * still starting, mid-turn, waiting on a person, broken. What the inbox push asks before it sends a notice.
     */
    promptable(agentId: AgentId): number | null {
        const entry = this.#running.get(agentId);
        return entry && entry.session.promptable ? entry.run : null;
    }

    /** The agent's current RUN while it has a session, promptable or not; `null` when it has none. */
    runOf(agentId: AgentId): number | null {
        return this.#running.get(agentId)?.run ?? null;
    }

    /** The agent's plan, reported through Genie's `plan` tool (`AgentSession.reportPlan`); `false` when it has no session. */
    reportPlan(agentId: AgentId, steps: readonly { content: string; status: string }[]): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;
        entry.session.reportPlan(steps);
        this.#emit(agentId);
        return true;
    }

    /** `context`: what the prompt's ledger row carries beyond its text — a Genie notice's mail (the inbox push). */
    prompt(agentId: AgentId, text: string, by: string | null = null, context: PromptContext = {}): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;
        entry.session.prompt(text, by, null, context);
        this.#emit(agentId);
        return true;
    }

    /**
     * STOP THE TURN, keep the agent: `Stop this turn` in the chat and the Agent view. The session stays in the map — its
     * slot, its provider and its conversation untouched — and the turn ends when the provider reports it cancelled.
     * Ending the agent is `stop` below, a different action. `not-running` for an agent with no session here.
     */
    cancel(agentId: AgentId, by: string | null = 'you'): CancelOutcome {
        const entry = this.#running.get(agentId);
        if (!entry) return { ok: false, reason: 'not-running' };

        const outcome = entry.session.cancel(by);
        this.#emit(agentId);
        return outcome;
    }

    /**
     * Stop means stop.
     *
     * The session kills the driver and reaps its own subtree. The slot frees here, which is
     * what makes the count honest — the previous build returned `ok: true` while leaving the
     * provider alive, so the owner had agents they could not stop AND a capacity figure that
     * never came back down.
     */
    stop(agentId: AgentId): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;

        entry.session.stop();
        this.#running.delete(agentId);
        // Its last rows (a cancelled approval, the reply the exit closes) are still on their way to the thread.
        this.#stopped.add(entry.session);
        this.#emit(agentId);
        return true;
    }

    /**
     * Resolves once every row this host's sessions have queued is in their threads — the running ones and the ones
     * stopped since, whose last rows are written AFTER the stop returns (see `AgentSession.settled`).
     *
     * A row is shown before it is written, so whatever removes or reads the store as finished — a test's teardown, a
     * quit — waits here first.
     *
     * A stopped session is forgotten only when its provider had EXITED (`exit` set) BEFORE this wait began — not merely
     * when it reads as not running. The exit handler is what writes the reply it closes, and `running` can read false
     * before that handler has run; an exit recorded before the wait had already queued its write, so the wait covered
     * it. One that exits during the wait stays, and the next `settled()` covers it.
     */
    async settled(): Promise<void> {
        const sessions = [...[...this.#running.values()].map((e) => e.session), ...this.#stopped];
        const exited = sessions.filter((s) => this.#stopped.has(s) && s.exit !== null);
        await Promise.all(sessions.map((s) => s.settled()));
        for (const s of exited) this.#stopped.delete(s);
    }

    /**
     * WHAT THE AGENT VIEW AND THE CHAT SHOW: the agent's recorded history, then this run. Claude resumes a conversation
     * without replaying it, so this run alone showed one turn of an agent holding 740k tokens of context (the owner,
     * beta.21) — and a stopped agent showed nothing at all. The history is read from the thread the session writes,
     * once per run, and announced when it lands; until then this run's rows stand alone.
     */
    ledgerFor(agentId: AgentId): readonly TimedEvent[] {
        const entry = this.#running.get(agentId);
        const before = entry ? entry.startedAt : null;
        const cached = this.#histories.get(agentId);
        if (cached === undefined || (cached !== 'loading' && cached.before !== before)) {
            this.#histories.set(agentId, 'loading');
            void readHistory(this.#store(), agentId, { ...(before !== null ? { before } : {}), limit: HISTORY_LIMIT })
                .then((h) => {
                    // NUMBERED as a person reads them (core/turn-numbers.ts): 1, 2, 3 … on from the turns the window cut off.
                    const rows = numberTurns([
                        ...(h.earlier > 0 ? [{ id: `${agentId}:earlier`, event: { kind: 'earlier' as const, count: h.earlier, turns: h.earlierTurns }, at: null }] : []),
                        ...h.rows.map((r) => ({ id: `${agentId}:h${r.position}`, event: r.event, at: r.at })),
                    ]);
                    this.#histories.set(agentId, { before, rows, turns: lastNumberedTurn(rows) });
                    this.#emit(agentId);
                })
                .catch(() => { this.#histories.set(agentId, { before, rows: [], turns: 0 }); });
        }
        const loaded = cached !== undefined && cached !== 'loading' && cached.before === before ? cached : null;
        const history = loaded ? loaded.rows : NO_ROWS;
        if (!entry) return history;
        /*
         * SERVED FROM WHAT IS KEPT (the owner, 2026-10-20: the window lagged seconds behind a busy agent): built again only
         * when a row changed, from rows that keep their identity while unchanged — which is what lets main send the window
         * only the rows that changed (core/agent-push-wire.ts).
         */
        if (entry.ledger !== null && entry.ledger.history === loaded) return entry.ledger.rows;
        // Where this run begins: said once, when there is something before it to tell it from — recorded rows, or a
        // conversation the provider resumed (which it remembers even when Genie recorded none of it).
        const marker: TimedEvent[] = history.length > 0 || entry.resumed ? [entry.marker] : [];
        // This run's turns number on from the history's — once it is read; until then they keep the session's own numbers.
        let run: readonly TimedEvent[] = entry.rows;
        if (loaded) {
            if (entry.numbered === null || entry.numbered.base !== loaded.turns) {
                const state = { n: loaded.turns };
                entry.numbered = { base: loaded.turns, rows: entry.rows.map((r) => numberRow(r, state)), n: 0 };
                entry.numbered.n = state.n;
            }
            run = entry.numbered.rows;
        }
        const rows = [...history, ...marker, ...run];
        entry.ledger = { history: loaded, rows };
        return rows;
    }

    /** THIS RUN's ledger only (what the doctor channel and file attribution read). Empty for one not running. */
    rowsFor(agentId: AgentId): readonly TimedEvent[] {
        return this.#running.get(agentId)?.rows ?? [];
    }

    /**
     * What the registry reads. `null` for an agent with no live session.
     *
     * Every field Genie has not been told is `null` here, and that is the last place the rule
     * can be lost: a `?? 0` in this method would turn "we have not heard" into "we looked and
     * it was none" for every row on the Dashboard at once.
     */
    probe(agentId: AgentId): LiveSession | null {
        const entry = this.#running.get(agentId);
        if (!entry) return null;

        const { session, rows, startedAt, mcp } = entry;

        // The last usage report, if any. Not a running total we maintain — the provider's own
        // figure, or nothing. Every reading from the rows is KEPT as they arrive (core/live-readings.ts): a probe never
        // reads the ledger again.
        const { readings } = entry;
        const contextUsed: number | null = readings.usage?.used ?? null;
        const contextSize: number | null = readings.usage?.size ?? null;

        /*
         * A failure, with the provider's LAST WORDS attached when it said any.
         *
         * `recentStderr` is where a provider explains itself — `command not found`, a bad flag,
         * an expired login — and a reason of "the turn did not finish" with that text sitting
         * unread in memory is the difference between an actionable row and a shrug.
         */
        const lastWords = session.recentStderr.at(-1);
        const failure =
            session.turnState === 'failed'
                ? {
                      reason:
                          session.failure ??
                          lastWords ??
                          'The turn did not finish, and the provider gave no reason.',
                      fixes: ['Restart'],
                      // How the process ended, as node reported it — for the Process ended block.
                      exit: session.exit,
                      at: session.failedAt,
                  }
                : null;

        return {
            limit: this.#gate.view(this.#loginOf(entry.provider), this.#clock()),
            signedOut: entry.session.signedOut,
            running: session.running,
            turnState: session.turnState,
            startedAt,
            mcpServers: mcp,
            /*
             * The parked approval, straight from the session.
             *
             * Codex raises these for its approvals. Claude raises them only for an agent set to
             * `ask` — its shell commands, through prism-acp's `permissionPrompts` (0.10.0). Both
             * land here the same way, with nothing here to tell them apart.
             */
            pendingApproval: session.pendingApproval,
            parkedAt: session.parkedAt,
            failure,
            contextUsed,
            contextSize,
            // The Dashboard's Latest delivery (core/delivery.ts): its own commit, file, handoff or answer, newest first.
            lastDelivery: readings.delivery(rows, this.#clock()),
            ...commsFields(this.#comms?.(agentId, startedAt) ?? null),
            plan: readings.plan,
            // The workspace dashboard's card (q_09d1f4a0): what started this turn, and the tool it is in now.
            ...(({ prompt, tool }) => ({ asked: prompt, tool }))(readings.turnNow()),
            model: readings.model,
            extensions: session.extensions,
            // Both, because each alone is a claim: the driver's declaration, and the driver this session actually holds.
            cancelTurn: entry.cancelDeclared && session.canCancelTurn,
        };
    }

    /** Turn count, for the Budget panel. `0` for an agent that has not run — a measured zero. */
    /** The provider's recent stderr, oldest first — what the process-ended block shows. Empty for one that is not running. */
    recentStderrFor(agentId: AgentId): readonly string[] {
        return this.#running.get(agentId)?.session.recentStderr ?? [];
    }

    turnsFor(agentId: AgentId): number {
        return this.#running.get(agentId)?.session.turns ?? 0;
    }

    /** Turns ended in this run only (doctor-mcp `askAndWait`); `turnsFor` numbers on from the recorded history. */
    turnsEndedThisRun(agentId: AgentId): number {
        return this.#running.get(agentId)?.session.turnsEndedThisRun ?? 0;
    }

    /** Stop everything. An upgrade ends every agent session and does not revive them. */
    stopAll(): void {
        for (const id of [...this.#running.keys()]) this.stop(id);
    }

    #emit(agentId: AgentId): void {
        for (const listener of this.#listeners) listener(agentId);
    }
}

/**
 * A row was appended: the readings and the numbered rows take it, and so does the ledger last served — GROWN IN PLACE,
 * not rebuilt (measured 2026-10-21: rebuilding 60k rows per change was 1.32 ms of an event's 1.18–2.12). The push reads
 * what changed from the length and last row it held (core/agent-push-wire.ts `rowsPatch`).
 */
function rowAdded(entry: Running): void {
    const index = entry.rows.length - 1;
    entry.readings.added(entry.rows, index);
    if (entry.numbered !== null) {
        const state = { n: entry.numbered.n };
        entry.numbered.rows.push(numberRow(entry.rows[index]!, state));
        entry.numbered.n = state.n;
    }
    if (entry.ledger === null) return;
    // Built over the numbered rows once the history was read (`ledgerFor`); over this run's own until then.
    if (entry.ledger.history !== null && entry.numbered === null) { entry.ledger = null; return; }
    entry.ledger.rows.push(entry.ledger.history !== null ? entry.numbered!.rows[index]! : entry.rows[index]!);
}

/** The newest row was replaced (a reply or a thought grew): `before` is the event it held. */
function rowReplaced(entry: Running, before: StreamEvent): void {
    const index = entry.rows.length - 1;
    const row = entry.rows[index]!;
    entry.readings.replaced(entry.rows, index, before);
    if (entry.numbered !== null) {
        // Only a turn, a stop or the earlier-rows marker carries or sets a number (core/turn-numbers.ts `numberRow`): a row
        // that was none of them and is none of them now (a reply growing, a tool call completing) keeps every number
        // where it was. Anything else is numbered again from the start — once per tool update over a 60k-row ledger was
        // most of what an event still cost (test/agent-stream-perf.test.ts).
        const numbers = (k: StreamEvent['kind']) => k === 'turn' || k === 'stopped' || k === 'earlier';
        const plain = !numbers(row.event.kind) && !numbers(before.kind);
        if (plain) entry.numbered.rows[index] = row;
        else entry.numbered = null;
    }
    if (entry.ledger === null) return;
    // Renumbered from the start: the ledger is built again. Otherwise its newest row is this one (only the newest is ever
    // replaced, which is what lets the push find the change without comparing the rows).
    if (entry.ledger.history !== null && entry.numbered === null) { entry.ledger = null; return; }
    entry.ledger.rows[entry.ledger.rows.length - 1] = row;
}

/** A measured comms reading as the row fields; `null` (not measured) leaves all three `null`, never `0`. */
function commsFields(c: Comms | null): { collaborators: number | null; commsAgeSeconds: number | null; links: Comms['links'] | null } {
    return { collaborators: c?.collaborators ?? null, commsAgeSeconds: c?.commsAgeSeconds ?? null, links: c?.links ?? null };
}
