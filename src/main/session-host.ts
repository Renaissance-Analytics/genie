import { ClaudeDriver, CodexDriver } from '@particle-academy/prism-acp';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import type { ProcessTree } from '../core/process-tree.js';
import { AgentSession, type SessionDriverFactory } from '../core/session.js';
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
export const realDriverFor: DriverFor = (record, cwd, resumeSessionId) => {
    const resume = resumeSessionId ? { resumeSessionId } : {};

    switch (record.provider) {
        case 'claude':
            return (options) =>
                new ClaudeDriver({ cwd, ...resume }, {
                    onUpdate: (u) => options.events.onUpdate?.(u as Record<string, unknown>),
                    onTurnEnd: (o) => options.events.onTurnEnd?.(o),
                    onExit: (code, signal) => options.events.onExit?.(code, signal),
                });

        case 'codex':
            return (options) =>
                new CodexDriver({ cwd, ...resume }, {
                    onUpdate: (u) => options.events.onUpdate?.(u as Record<string, unknown>),
                    onTurnEnd: (o) => options.events.onTurnEnd?.(o),
                    onExit: (code, signal) => options.events.onExit?.(code, signal),
                });

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
            onEvent: (event: StreamEvent) => {
                rows.push({ id: `${record.id}:${entry.nextRowId++}`, event, at: this.#clock() });
                this.#emit(record.id);
            },
        });

        entry.session = session;
        this.#running.set(record.id, entry);

        session.start();
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

        const failure =
            session.turnState === 'failed'
                ? {
                      reason: session.failure ?? 'The turn did not finish, and the provider gave no reason.',
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
