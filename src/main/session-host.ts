import { ClaudeDriver, CodexDriver } from '@particle-academy/prism-acp';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import type { ProcessTree } from '../core/process-tree.js';
import {
    AgentSession,
    type DriverEvents,
    type PermissionOutcomeLike,
    type PermissionRequestLike,
    type SessionDriverFactory,
    type TurnOutcomeLike,
} from '../core/session.js';
import type { StreamEvent } from '../core/stream-event.js';
import type { TimedEvent } from '../core/stream-view.js';
import { openDurableStore } from '../core/thread-store.js';
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
export type DriverFor = (record: AgentRecord, cwd: string, resumeSessionId: string | null) => SessionDriverFactory | null;

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
    onProtocolError: (problem: string) => void;
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
        onProtocolError: (problem) => events.onProtocolError?.(problem),
        onStderr: (line) => events.onStderr?.(line),
        onExit: (code, signal) => events.onExit?.(code, signal),
    };
}

export const realDriverFor: DriverFor = (record, cwd, resumeSessionId) => {
    const resume = resumeSessionId ? { resumeSessionId } : {};
    const configured = providerBinary(record.provider);
    const binary = configured ? { binary: configured } : {};

    switch (record.provider) {
        case 'claude':
            return (options) => new ClaudeDriver({ cwd, ...resume, ...binary }, driverEvents(options.events));

        case 'codex':
            return (options) => new CodexDriver({ cwd, ...resume, ...binary }, driverEvents(options.events));

        default:
            return null;
    }
};

interface Running {
    session: AgentSession;
    /** The ledger, with arrival times. Timestamps are recorded HERE because this is where the
     *  event arrives — the wire carries none, and a time invented later would be a guess. */
    rows: TimedEvent[];
    startedAt: number;
    nextRowId: number;
}

export class SessionHost {
    readonly #userData: string;
    readonly #driverFor: DriverFor;
    readonly #clock: () => number;
    readonly #running = new Map<AgentId, Running>();
    #listeners = new Set<(agentId: AgentId) => void>();

    /** Why a start was refused, by agent. Reported, never swallowed. */
    readonly refusals = new Map<AgentId, string>();

    readonly #processTree: ProcessTree | undefined;

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
    }) {
        this.#userData = options.userData;
        this.#driverFor = options.driverFor ?? realDriverFor;
        this.#clock = options.clock ?? (() => Date.now());
        this.#processTree = options.processTree;
    }

    /** Live sessions. The ONLY correct source for "how many agents are running". */
    get count(): number {
        return this.#running.size;
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

        const driverFactory = this.#driverFor(record, cwd, record.threadId);
        if (!driverFactory) {
            const reason = `Genie cannot run a "${record.provider}" agent. It stays registered and idle.`;
            this.refusals.set(record.id, reason);
            this.#emit(record.id);
            return { ok: false, reason };
        }

        this.refusals.delete(record.id);

        const rows: TimedEvent[] = [];
        const entry: Running = { session: null as unknown as AgentSession, rows, startedAt: this.#clock(), nextRowId: 0 };

        const session = new AgentSession({
            agentId: record.id,
            cwd,
            store: openDurableStore(sessionsDir(this.#userData)),
            driverFactory,
            ...(record.threadId ? { resumeSessionId: record.threadId } : {}),
            ...(this.#processTree ? { processTree: this.#processTree } : {}),
            /*
             * A change the UI renders — a parked approval, an answered one, a turn ending.
             *
             * Without this the renderer learned about an approval only when the NEXT ledger row
             * happened to arrive, and a blocked agent produces no further rows by definition.
             */
            onStateChange: () => this.#emit(record.id),
            onEvent: (event: StreamEvent) => {
                rows.push({ id: `${record.id}:${entry.nextRowId++}`, event, at: this.#clock() });
                this.#emit(record.id);
            },
        });

        entry.session = session;
        this.#running.set(record.id, entry);

        /**
         * A provider can fail to spawn SYNCHRONOUSLY, and that path reaches none of the
         * driver's event handlers.
         *
         * Measured on Windows with the real binary:
         *
         *     spawn('…/npm/codex.cmd', ['app-server', …])  ->  EINVAL, thrown synchronously
         *
         * npm installs CLIs on Windows as `.cmd` shims and Node refuses to spawn one without
         * `shell: true` (the CVE-2024-27980 fix). `claude` happens to be a `.exe` so it is
         * fine; `codex` is a `.cmd` and is not.
         *
         * Because the throw is synchronous it never reaches `onExit` or `onProtocolError`, and
         * the renderer calls `openAgent` through `void ipcRenderer.invoke(...)`, which swallows
         * a rejection. **Clicking a codex agent on Windows did nothing at all, silently** — no
         * red row, no message, no console error. The same silent-failure class as the dropped
         * `onProtocolError`, arriving by a different door.
         *
         * The half-started session is removed rather than left in the map: capacity consumed by
         * nothing, and a row that reads as running when no process exists.
         */
        try {
            session.start();
        } catch (error) {
            this.#running.delete(record.id);

            const configured = providerBinary(record.provider);
            const reason = [
                `Genie could not start ${record.provider}: ${String((error as Error).message ?? error)}.`,
                // The PATH is the whole diagnosis on Windows, where the `.cmd` extension IS the
                // cause. "spawn EINVAL" alone sends somebody to the wrong place entirely.
                configured ? `Configured binary: ${configured}` : null,
            ]
                .filter(Boolean)
                .join(' ');

            this.refusals.set(record.id, reason);
            this.#emit(record.id);
            return { ok: false, reason };
        }

        this.#emit(record.id);
        return { ok: true };
    }

    /**
     * Answer a parked approval, with the provider's own option id.
     *
     * Returns false when there was nothing parked or the id was not offered — the session
     * checks, because the renderer is not trusted to send back a valid one.
     */
    answerApproval(agentId: AgentId, optionId: string): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;

        const answered = entry.session.answerApproval(optionId);
        if (answered) this.#emit(agentId);
        return answered;
    }

    prompt(agentId: AgentId, text: string): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;
        entry.session.prompt(text);
        this.#emit(agentId);
        return true;
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
        this.#emit(agentId);
        return true;
    }

    /** The ledger for one agent. Empty for one that has never run — which is not an error. */
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

        const { session, rows, startedAt } = entry;

        // The last usage report, if any. Not a running total we maintain — the provider's own
        // figure, or nothing.
        let contextUsed: number | null = null;
        let contextSize: number | null = null;
        for (const row of rows) {
            if (row.event.kind === 'usage') {
                contextUsed = row.event.used;
                contextSize = row.event.size;
            }
        }

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
                  }
                : null;

        return {
            running: session.running,
            turnState: session.turnState,
            startedAt,
            /*
             * The parked approval, straight from the session.
             *
             * `ClaudeDriver.permissionRequests` is false in prism-acp 0.6.1 — claude does not
             * send these over ACP yet — and `CodexDriver`'s is true. So this is exercised today
             * by codex and will light up for claude when 0.7.0 lands, with nothing here to
             * change: only the driver's capability flips.
             */
            pendingApproval: session.pendingApproval,
            failure,
            contextUsed,
            contextSize,
            lastDelivery: null,
            collaborators: null,
            commsAgeSeconds: null,
            plan: planFrom(rows),
        };
    }

    /** Turn count, for the Budget panel. `0` for an agent that has not run — a measured zero. */
    turnsFor(agentId: AgentId): number {
        return this.#running.get(agentId)?.session.turns ?? 0;
    }

    /** Stop everything. An upgrade ends every agent session and does not revive them. */
    stopAll(): void {
        for (const id of [...this.#running.keys()]) this.stop(id);
    }

    #emit(agentId: AgentId): void {
        for (const listener of this.#listeners) listener(agentId);
    }
}

/** The latest plan the agent reported, or `null`. Never a fabricated `0/0`. */
function planFrom(rows: readonly TimedEvent[]): LiveSession['plan'] {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const event = rows[i]?.event;
        if (event?.kind !== 'plan') continue;

        const steps = event.entries.flatMap((e) => {
            if (typeof e !== 'object' || e === null) return [];
            const r = e as Record<string, unknown>;
            return typeof r['content'] === 'string' && typeof r['status'] === 'string'
                ? [{ content: r['content'], status: r['status'] }]
                : [];
        });
        if (steps.length === 0) return null;

        const done = steps.filter((s) => s.status === 'completed').length;
        const doing = steps.find((s) => s.status === 'in_progress');
        return { step: done, of: steps.length, doing: doing?.content ?? '' };
    }
    return null;
}
