import { OutputTail, type ProcessLog } from '../core/output-tail.js';
import type { PtyPort } from './terminal-host.js';

/**
 * BACKGROUND PROCESSES AND SITE PROCESSES (§6.6) — Genie's supervisor over `PtyPort`.
 *
 * Two of §1's four legitimate uses of a pty live here: a background process Genie supervises
 * (a queue worker, a watcher, a dev server) and a hosted site's server process. **No agent is
 * ever one of these.** `ProcessSpec` has no agent field and `test/process-supervisor.test.ts`
 * counts that.
 *
 * ## Restart is a policy, and `stop` means stop
 *
 * The policy applies only to exits the supervisor did not cause. A process the user stopped is
 * never revived by its own policy — the previous build's host-loss recovery resurrected eleven
 * agents the owner had stopped, and the lesson generalises: every path that could start
 * something checks one flag, `wanted`, and a stop clears it.
 *
 * Backoff doubles from one second; after five consecutive failures the process is `failed` with
 * the reason, because a process restarted forever reads as running from across the room. A run
 * that stays up for a minute resets the count.
 *
 * ## The log outlives the run (hosting ship line P1)
 *
 * Every process has an `OutputTail` (core/output-tail.ts) the supervisor fills from the pty's
 * output. It is the supervisor's, not the pty's: it survives the process exiting, crashing, being
 * restarted by its policy or by hand, and is gone only when the process is forgotten. Genie writes
 * its own lines into it (`[genie] exited with code 1; restarting in 1s`), so a crash reads as one
 * in the log a person or an agent opens afterwards.
 *
 * ## Running means running (P2)
 *
 * State is written at spawn and at the pty's exit event, so a process whose pty disappears WITHOUT
 * one (Genie 1's genie#655: workers listed `running`, none on the host, the queue unclaimed) would
 * read `running` forever. `recheck()` ASKS — the pty engine whether the pty is live, and the OS
 * whether its pid is — and a running process that is gone is routed through the one exit path as a
 * crash (exit code -1), so its restart policy, its backoff and the person's stop still decide what
 * happens. It runs on `watchLiveness`'s heartbeat (30 s, as Genie 1) and whenever any pty exits: a
 * lost pty host takes every pty at once, and one exit seen is the cue to look at the rest. A process
 * first seen gone is only SUSPECT — its own exit event may still be on its way with the real code,
 * and a clean exit must not be read as a crash — so it is declared lost only if it is still gone
 * `LOST_GRACE_MS` later, and that second look is scheduled, not left to the next heartbeat.
 */

export type RestartPolicy = 'never' | 'on-failure' | 'always';

export interface ProcessSpec {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly command: string;
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly restart: RestartPolicy;
}

export type ProcessState = 'running' | 'restarting' | 'stopped' | 'exited' | 'failed';

export interface ProcessStatus {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly state: ProcessState;
    readonly pid: number | null;
    readonly exitCode: number | null;
    /** Automatic restarts since the last manual start/restart. */
    readonly restarts: number;
    readonly since: number;
    readonly reason?: string;
}

export interface SupervisorClock {
    readonly now: () => number;
    /** Run `fn` after `ms`; returns a cancel. Injected so tests drive time and production uses setTimeout. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
}

/** How the supervisor learns a process is really there, beyond the pty's exit event (P2). */
export interface SupervisorLiveness {
    /** Whether `pid` still names a live OS process. Absent = only the pty engine is asked. */
    readonly pidAlive?: (pid: number) => boolean;
}

/** The OS's answer for a pid: signal 0 delivers nothing, and only "no such process" means gone (EPERM is alive). */
export function osPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

const FIRST_BACKOFF_MS = 1_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const HEALTHY_AFTER_MS = 60_000;
/** Genie 1's `PROCESS_RECONCILE_MS`: long enough to be free, short enough that a lost process is never stale for long. */
export const LIVENESS_INTERVAL_MS = 30_000;
/** How long a process seen gone may still deliver its own exit before it is declared lost. */
export const LOST_GRACE_MS = 5_000;

interface Entry {
    spec: ProcessSpec;
    ptyId: string | null;
    pid: number | null;
    state: ProcessState;
    exitCode: number | null;
    restarts: number;
    consecutiveFailures: number;
    startedAt: number;
    since: number;
    /** Cleared by `stop`; every start path checks it. */
    wanted: boolean;
    cancelRestart: (() => void) | null;
    reason?: string;
    /** The output so far, across every run of this process (P1). */
    log: OutputTail;
    /** When `recheck` first found this run gone; null while it is there (P2). */
    suspectAt: number | null;
}

export class ProcessSupervisor {
    readonly #pty: PtyPort;
    readonly #clock: SupervisorClock;
    readonly #liveness: SupervisorLiveness;
    readonly #entries = new Map<string, Entry>();
    readonly #byPty = new Map<string, string>();
    readonly #changeListeners = new Set<(status: ProcessStatus) => void>();
    readonly #outputListeners = new Set<(id: string, data: string) => void>();
    #confirmPending = false;

    constructor(
        pty: PtyPort,
        clock: SupervisorClock = { now: Date.now, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } },
        liveness: SupervisorLiveness = {},
    ) {
        this.#pty = pty;
        this.#clock = clock;
        this.#liveness = liveness;
        pty.onExit((ptyId, exitCode) => {
            this.#onExit(ptyId, exitCode);
            // One exit seen is the cue to look at the rest: a lost pty host takes every pty at once.
            this.recheck();
        });
        pty.onData((ptyId, data) => {
            const id = this.#byPty.get(ptyId);
            if (id === undefined) return;
            this.#entries.get(id)?.log.append(data);
            for (const l of this.#outputListeners) l(id, data);
        });
    }

    start(spec: ProcessSpec): ProcessStatus {
        const existing = this.#entries.get(spec.id);
        if (existing && existing.state === 'running') return this.#status(existing);
        if (existing?.cancelRestart) existing.cancelRestart();
        const entry: Entry = {
            spec,
            ptyId: null,
            pid: null,
            state: 'stopped',
            exitCode: null,
            restarts: 0,
            consecutiveFailures: 0,
            startedAt: 0,
            since: this.#clock.now(),
            wanted: true,
            cancelRestart: null,
            // The log is the PROCESS's, not the run's: a start after a stop or a crash keeps what came before.
            log: existing?.log ?? new OutputTail(),
            suspectAt: null,
        };
        this.#entries.set(spec.id, entry);
        this.#spawn(entry);
        return this.#status(entry);
    }

    stop(id: string): boolean {
        const entry = this.#entries.get(id);
        if (!entry) return false;
        entry.wanted = false;
        if (entry.cancelRestart) {
            entry.cancelRestart();
            entry.cancelRestart = null;
        }
        if (entry.ptyId !== null) {
            this.#pty.kill(entry.ptyId);
            this.#byPty.delete(entry.ptyId);
            entry.ptyId = null;
        }
        entry.pid = null;
        entry.suspectAt = null;
        this.#transition(entry, 'stopped');
        return true;
    }

    /**
     * Stop it AND forget it: it leaves `list()`. `stop` keeps a stopped entry so its row stays
     * visible; a process that was REMOVED must not linger as a stopped row whose Restart revives it.
     */
    forget(id: string): boolean {
        if (!this.stop(id)) return false;
        this.#entries.delete(id);
        return true;
    }

    /** Stop the current run and start a new one, by hand: the failure count starts over. */
    restart(id: string): ProcessStatus | null {
        const entry = this.#entries.get(id);
        if (!entry) return null;
        this.stop(id);
        return this.start(entry.spec);
    }

    status(id: string): ProcessStatus | null {
        const entry = this.#entries.get(id);
        return entry ? this.#status(entry) : null;
    }

    list(workspaceId?: string): ProcessStatus[] {
        return [...this.#entries.values()]
            .filter((e) => workspaceId === undefined || e.spec.workspaceId === workspaceId)
            .map((e) => this.#status(e));
    }

    /** The command a process runs, as started — what the toolchain's update guard reads to see who runs on Node. */
    command(id: string): string | undefined {
        return this.#entries.get(id)?.spec.command;
    }

    /**
     * The process's output so far, across its runs — kept by the supervisor, so it is there after the
     * process exited or crashed. `undefined` only for a process the supervisor does not know.
     */
    log(id: string): string | undefined {
        return this.readLog(id)?.text;
    }

    /** The last `lines` lines of the process's output (all that is kept when absent), with how many the bound has cut. */
    readLog(id: string, lines?: number): ProcessLog | null {
        const entry = this.#entries.get(id);
        return entry ? entry.log.read(lines) : null;
    }

    /**
     * ASK whether every `running` process is really there (P2). A process gone without an exit event is
     * suspect first; still gone `LOST_GRACE_MS` later, it is a crash with exit code -1, through the one
     * exit path. Changes nothing while everything is there. Returns the ids declared lost.
     */
    recheck(): string[] {
        const now = this.#clock.now();
        const lost: string[] = [];
        let suspects = false;
        for (const entry of [...this.#entries.values()]) {
            if (entry.state !== 'running' || entry.ptyId === null) continue;
            if (this.#gone(entry) !== true) {
                entry.suspectAt = null;
                continue;
            }
            if (entry.suspectAt === null || now - entry.suspectAt < LOST_GRACE_MS) {
                entry.suspectAt ??= now;
                suspects = true;
                continue;
            }
            const ptyId = entry.ptyId;
            entry.log.note('this process is no longer running, and Genie never saw it exit (the pty engine or the OS has no process for it); treating it as a crash');
            lost.push(entry.spec.id);
            // -1: an exit nobody observed is not a clean one; 0 would send a crashed process down the "exited normally" path.
            this.#onExit(ptyId, -1);
            // An engine still holding a pty for a dead process lets it go; one that already has answers false. Its exit,
            // if one ever comes, finds nothing: the run was already routed.
            this.#pty.kill(ptyId);
        }
        // The second look is ASKED FOR, not left to the next heartbeat.
        if (suspects && !this.#confirmPending) {
            this.#confirmPending = true;
            this.#clock.schedule(() => {
                this.#confirmPending = false;
                this.recheck();
            }, LOST_GRACE_MS);
        }
        return lost;
    }

    /** `recheck` on a heartbeat until the returned stop is called. A recheck that throws never stops the heartbeat. */
    watchLiveness(intervalMs: number = LIVENESS_INTERVAL_MS): () => void {
        let on = true;
        let cancel: (() => void) | null = null;
        const tick = () => {
            if (!on) return;
            try {
                this.recheck();
            } catch (error) {
                console.error(`[processes] the liveness check failed: ${(error as Error).message}`);
            }
            cancel = this.#clock.schedule(tick, intervalMs);
        };
        cancel = this.#clock.schedule(tick, intervalMs);
        return () => {
            on = false;
            cancel?.();
        };
    }

    onChange(listener: (status: ProcessStatus) => void): () => void {
        this.#changeListeners.add(listener);
        return () => this.#changeListeners.delete(listener);
    }

    onOutput(listener: (id: string, data: string) => void): () => void {
        this.#outputListeners.add(listener);
        return () => this.#outputListeners.delete(listener);
    }

    /** true = gone; false = there; undefined = nothing here can tell (an engine without `isLive`, and no pid probe). */
    #gone(entry: Entry): boolean | undefined {
        const ptyLive = entry.ptyId === null ? false : this.#pty.isLive?.(entry.ptyId);
        if (ptyLive === false) return true;
        const pidAlive = this.#liveness.pidAlive;
        if (pidAlive && entry.pid !== null) return !pidAlive(entry.pid);
        return ptyLive === undefined ? undefined : false;
    }

    #spawn(entry: Entry): void {
        const opened = this.#pty.open({
            cwd: entry.spec.cwd,
            command: entry.spec.command,
            ...(entry.spec.env ? { env: { ...entry.spec.env } } : {}),
        });
        entry.ptyId = opened.id;
        entry.pid = opened.pid;
        entry.exitCode = null;
        entry.startedAt = this.#clock.now();
        entry.cancelRestart = null;
        entry.suspectAt = null;
        this.#byPty.set(opened.id, entry.spec.id);
        entry.log.note(`started (pid ${opened.pid}): ${entry.spec.command}`);
        this.#transition(entry, 'running');
    }

    #onExit(ptyId: string, exitCode: number): void {
        const id = this.#byPty.get(ptyId);
        if (id === undefined) return; // a stop already forgot it: not a failure, nothing to do
        this.#byPty.delete(ptyId);
        const entry = this.#entries.get(id);
        if (!entry || entry.ptyId !== ptyId) return;
        entry.ptyId = null;
        entry.pid = null;
        entry.exitCode = exitCode;
        entry.suspectAt = null;
        if (!entry.wanted) {
            this.#transition(entry, 'stopped');
            return;
        }

        const failed = exitCode !== 0;
        const policyRestarts = entry.spec.restart === 'always' || (entry.spec.restart === 'on-failure' && failed);
        if (!policyRestarts) {
            entry.log.note(`exited with code ${exitCode}`);
            this.#transition(entry, 'exited');
            return;
        }

        const healthy = this.#clock.now() - entry.startedAt >= HEALTHY_AFTER_MS;
        entry.consecutiveFailures = healthy ? 1 : entry.consecutiveFailures + 1;
        if (entry.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            entry.reason = `gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures (last exit code ${exitCode}); restart it by hand when the cause is fixed`;
            entry.log.note(`exited with code ${exitCode}; ${entry.reason}`);
            this.#transition(entry, 'failed');
            return;
        }

        const delay = FIRST_BACKOFF_MS * 2 ** (entry.consecutiveFailures - 1);
        entry.log.note(`exited with code ${exitCode}; restarting in ${delay / 1000}s`);
        this.#transition(entry, 'restarting');
        entry.cancelRestart = this.#clock.schedule(() => {
            if (!entry.wanted) return;
            entry.restarts += 1;
            this.#spawn(entry);
        }, delay);
    }

    #transition(entry: Entry, state: ProcessState): void {
        entry.state = state;
        entry.since = this.#clock.now();
        if (state !== 'failed') delete entry.reason;
        const status = this.#status(entry);
        for (const l of this.#changeListeners) l(status);
    }

    #status(entry: Entry): ProcessStatus {
        return {
            id: entry.spec.id,
            workspaceId: entry.spec.workspaceId,
            name: entry.spec.name,
            state: entry.state,
            pid: entry.pid,
            exitCode: entry.exitCode,
            restarts: entry.restarts,
            since: entry.since,
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        };
    }
}
