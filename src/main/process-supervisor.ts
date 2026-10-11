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

const FIRST_BACKOFF_MS = 1_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const HEALTHY_AFTER_MS = 60_000;

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
}

export class ProcessSupervisor {
    readonly #pty: PtyPort;
    readonly #clock: SupervisorClock;
    readonly #entries = new Map<string, Entry>();
    readonly #byPty = new Map<string, string>();
    readonly #changeListeners = new Set<(status: ProcessStatus) => void>();
    readonly #outputListeners = new Set<(id: string, data: string) => void>();

    constructor(pty: PtyPort, clock: SupervisorClock = { now: Date.now, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }) {
        this.#pty = pty;
        this.#clock = clock;
        pty.onExit((ptyId, exitCode) => this.#onExit(ptyId, exitCode));
        pty.onData((ptyId, data) => {
            const id = this.#byPty.get(ptyId);
            if (id !== undefined) for (const l of this.#outputListeners) l(id, data);
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
        this.#transition(entry, 'stopped');
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

    /** The process's output so far — the pty's scrollback. `undefined` when it has no live pty. */
    log(id: string): string | undefined {
        const entry = this.#entries.get(id);
        return entry?.ptyId ? this.#pty.scrollback(entry.ptyId) : undefined;
    }

    onChange(listener: (status: ProcessStatus) => void): () => void {
        this.#changeListeners.add(listener);
        return () => this.#changeListeners.delete(listener);
    }

    onOutput(listener: (id: string, data: string) => void): () => void {
        this.#outputListeners.add(listener);
        return () => this.#outputListeners.delete(listener);
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
        this.#byPty.set(opened.id, entry.spec.id);
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
        if (!entry.wanted) {
            this.#transition(entry, 'stopped');
            return;
        }

        const failed = exitCode !== 0;
        const policyRestarts = entry.spec.restart === 'always' || (entry.spec.restart === 'on-failure' && failed);
        if (!policyRestarts) {
            this.#transition(entry, 'exited');
            return;
        }

        const healthy = this.#clock.now() - entry.startedAt >= HEALTHY_AFTER_MS;
        entry.consecutiveFailures = healthy ? 1 : entry.consecutiveFailures + 1;
        if (entry.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            entry.reason = `gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures (last exit code ${exitCode}); restart it by hand when the cause is fixed`;
            this.#transition(entry, 'failed');
            return;
        }

        const delay = FIRST_BACKOFF_MS * 2 ** (entry.consecutiveFailures - 1);
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
