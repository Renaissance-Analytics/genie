import { statSync } from 'node:fs';
import { ClaudeDriver, CodexDriver } from '@particle-academy/prism-acp';
import { threadIdIsResumable, type AgentId, type AgentRecord } from '../core/identity.js';
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
    }) {
        this.#userData = options.userData;
        this.#driverFor = options.driverFor ?? realDriverFor;
        this.#clock = options.clock ?? (() => Date.now());
        this.#processTree = options.processTree;
        this.#onThreadId = options.onThreadId;
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
                const last = rows.at(-1);
                if (meta?.replacesLast && last) {
                    rows[rows.length - 1] = { ...last, event };
                } else {
                    rows.push({ id: `${record.id}:${entry.nextRowId++}`, event, at: this.#clock() });
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

    /** `by` is who started the turn, when the caller knows (`you`, `genie`, a peer's name); it is written into the ledger. */
    prompt(agentId: AgentId, text: string, by: string | null = null): boolean {
        const entry = this.#running.get(agentId);
        if (!entry) return false;
        entry.session.prompt(text, by);
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
    /** The provider's recent stderr, oldest first — what the process-ended block shows. Empty for one that is not running. */
    recentStderrFor(agentId: AgentId): readonly string[] {
        return this.#running.get(agentId)?.session.recentStderr ?? [];
    }

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
