import { nextCronAfter } from '../core/cron.js';
import type { LastRunStatus } from '../core/scheduled-task.js';
import type { KeptProcess, ProcessBook } from './process-book.js';
import type { ProcessStatus, ProcessSupervisor } from './process-supervisor.js';

/**
 * SCHEDULED TASKS' CLOCK (genie#1204) — Genie 1's host-layer scheduler (main/terminal/process-scheduler.ts at
 * v0.7.0-beta.342), ported onto Genie 2's process book and supervisor. It decides WHEN; the supervisor runs.
 *
 * - **Never polls.** One timer, aimed at the nearest due among the ENABLED scheduled tasks; it re-plans after each fire and
 *   on every change to the book. A paused task, or one in a sleeping workspace (Genie 1's genie#672), is not armed.
 * - **Missed runs are not caught up.** The next due is always computed forward from now: a Genie that was closed at 03:00
 *   does not run the nightly job at launch (Genie 1's rule: a backlog firing at once is worse than a skipped night).
 * - **One-shot.** A `command` fire starts the kept process through the supervisor with restart `never`, exactly as the
 *   person's Start would, in its folder, with its workspace's env; its exit is the run's outcome (0 ok, else failed).
 * - **Overlap guard.** A task whose previous run is still going is SKIPPED — never a second copy beside the first.
 * - **agent-nudge** hands the prompt to the agent AS THE TASK (Genie 1's genie#543: the sender names the task); delivery
 *   waits for the agent's turn to end, never landing inside one (Genie 1 delivered through AgentInbox's idle gate). The
 *   outcome is whether it could be delivered.
 * - **Run now** runs a task once, enabled or paused (Genie 1's run-now) — not in a sleeping workspace.
 */

export type RunNowResult = 'started' | 'ok' | 'failed' | 'skipped' | 'held';

export interface ProcessSchedulerDeps {
    readonly book: Pick<ProcessBook, 'scheduledTasks' | 'recordScheduledRun' | 'onChange'>;
    readonly supervisor: Pick<ProcessSupervisor, 'start' | 'status' | 'onChange'>;
    readonly envFor: (workspaceId: string) => Readonly<Record<string, string>>;
    readonly asleep: (workspaceId: string) => boolean;
    /** Deliver `text` to the agent at `address`, from the task named `from` — now, or when its turn ends. False = nowhere to deliver. */
    readonly nudge: (address: string, text: string, from: string) => boolean;
    readonly now: () => number;
    readonly schedule: (fn: () => void, ms: number) => () => void;
}

export class ProcessScheduler {
    readonly #deps: ProcessSchedulerDeps;
    #cancel: (() => void) | null = null;
    /** Command runs in flight: the task id → its run's start, settled when the supervisor reports its exit. */
    readonly #inFlight = new Map<string, { at: number; done: Promise<void>; finish: () => void }>();
    /** Outcome writes not yet on disk (and not yet told to the book's listeners) — `settled()` waits for these too. */
    readonly #recording = new Set<Promise<void>>();

    constructor(deps: ProcessSchedulerDeps) {
        this.#deps = deps;
        deps.book.onChange(() => this.plan());
        deps.supervisor.onChange((s) => this.#exited(s));
    }

    /** Aim the one timer at the nearest due among enabled, awake scheduled tasks; nothing armed = no timer. */
    plan(): void {
        this.#cancel?.();
        this.#cancel = null;
        const now = this.#deps.now();
        let at: number | null = null;
        let due: string[] = [];
        for (const p of this.#deps.book.scheduledTasks()) {
            if (!p.wanted || this.#deps.asleep(p.workspaceId)) continue;
            const t = nextCronAfter(p.schedule!.cron, now, undefined);
            if (t === null) continue;
            if (at === null || t < at) { at = t; due = [p.id]; } else if (t === at) due.push(p.id);
        }
        if (at === null) return;
        const target = at;
        const ids = due;
        this.#cancel = this.#deps.schedule(() => this.#fire(ids), Math.max(0, target - now));
    }

    /** Run a task once, now — enabled or paused. Answers what happened ('started' = a command is running). */
    async runNow(id: string): Promise<RunNowResult> {
        const p = this.#deps.book.scheduledTasks().find((x) => x.id === id);
        if (!p) throw new Error(`no scheduled task ${id}`);
        return this.#run(p);
    }

    /**
     * Resolves when no command run is in flight AND every run's outcome is written (and told to the book's listeners).
     *
     * genie#1250: this used to wait on `#inFlight` alone, and a run leaves `#inFlight` the moment its exit is seen,
     * BEFORE its outcome is written. So it resolved with the write still to come (a timer-fired nudge's write was never
     * tracked at all). In the tests the late write told its book's listeners after the test had ended, and that test's
     * scheduler re-planned, arming a timer inside the NEXT test (PR #1247's CI). Whoever awaits this now gets a finished run.
     */
    async settled(): Promise<void> {
        while (this.#inFlight.size > 0 || this.#recording.size > 0) {
            await Promise.all([...[...this.#inFlight.values()].map((r) => r.done), ...this.#recording]);
        }
    }

    #fire(ids: readonly string[]): void {
        this.#cancel = null;
        const tasks = this.#deps.book.scheduledTasks().filter((p) => ids.includes(p.id) && p.wanted);
        // Re-plan FIRST, so the next due is held whatever the runs do.
        this.plan();
        for (const p of tasks) void this.#run(p).catch((error: unknown) => console.error(`[genie] scheduled task ${p.name}: ${error instanceof Error ? error.message : String(error)}`));
    }

    async #run(p: KeptProcess): Promise<RunNowResult> {
        if (this.#deps.asleep(p.workspaceId)) return 'held';
        const at = this.#deps.now();
        const schedule = p.schedule!;
        const live = this.#deps.supervisor.status(p.id);
        if (this.#inFlight.has(p.id) || live?.state === 'running' || live?.state === 'restarting') {
            await this.#record(p.id, at, 'skipped');
            return 'skipped';
        }
        if (schedule.kind === 'agent-nudge') {
            let ok = false;
            try { ok = this.#deps.nudge(schedule.agent ?? '', schedule.prompt ?? '', p.name); } catch { ok = false; }
            await this.#record(p.id, at, ok ? 'ok' : 'failed');
            return ok ? 'ok' : 'failed';
        }
        let finish!: () => void;
        const done = new Promise<void>((r) => { finish = r; });
        this.#inFlight.set(p.id, { at, done, finish });
        try {
            const env = this.#deps.envFor(p.workspaceId);
            this.#deps.supervisor.start({ id: p.id, workspaceId: p.workspaceId, name: p.name, command: p.command, cwd: p.cwd, restart: 'never', ...(Object.keys(env).length > 0 ? { env: { ...env } } : {}) });
        } catch (error) {
            this.#inFlight.delete(p.id);
            finish();
            await this.#record(p.id, at, 'failed');
            throw error;
        }
        return 'started';
    }

    #exited(s: ProcessStatus): void {
        const run = this.#inFlight.get(s.id);
        if (!run) return;
        if (s.state !== 'exited' && s.state !== 'failed' && s.state !== 'stopped') return;
        this.#inFlight.delete(s.id);
        const status: LastRunStatus = s.state === 'exited' && s.exitCode === 0 ? 'ok' : 'failed';
        void this.#record(s.id, run.at, status).finally(() => run.finish());
    }

    /** Every outcome write is tracked until it has landed, so `settled()` covers it whichever path started it. */
    #record(id: string, at: number, status: LastRunStatus): Promise<void> {
        const write: Promise<void> = this.#deps.book.recordScheduledRun(id, at, status).catch(() => {}).finally(() => { this.#recording.delete(write); });
        this.#recording.add(write);
        return write;
    }
}
