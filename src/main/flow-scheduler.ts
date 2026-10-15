import { nextCronAfter } from '../core/cron.js';
import type { FlowRecord, FlowRun, FlowStore, RunOutcome, Schedule } from './flow-store.js';

/**
 * FLOWS (§6.6) — the scheduler. ONE timer, set to the nearest due among the ARMED flows'
 * schedule triggers; when it fires, the flow runs and the timer is set again. Never a poll:
 * nothing ticks, nothing scans on an interval. The store's `onChange` is what re-plans — an arm,
 * a disarm, a document edit, a removal.
 *
 * ## Every run has an outcome (hosting ship line P4)
 *
 * `run` executes the flow (flow-runner.ts in production) and answers what happened: it RAN, it
 * FAILED with a reason, or it was HELD back with why. A run that throws is a failure with the
 * error's words. Whatever happens is recorded on the flow (`FlowStore.recordRun`), and none of it
 * stops the schedule: the next due is planned first, because a flow that silently stops firing
 * after one bad night is the failure a scheduler exists to prevent.
 *
 * ## Never two copies of one flow
 *
 * A flow whose previous run is still going when it is due again (or when the person presses Run now)
 * is HELD back and says so, rather than starting a second copy beside the first — Genie 1's overlap
 * guard. Different flows run side by side.
 *
 * ## Missed runs are not caught up
 *
 * The next due is always computed forward from now. A Genie that was closed at 03:00 does not run
 * the nightly job at launch, as Genie 1 did not: a backlog firing at once is worse than a skipped night.
 */

export type RunResult = { readonly outcome: 'ran' } | { readonly outcome: 'failed' | 'held'; readonly reason: string };

export interface FlowSchedulerDeps {
    readonly store: FlowStore;
    readonly now: () => number;
    /** Run `fn` after `ms`; returns a cancel. Injected so tests drive time. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
    /**
     * Execute one run of a flow. `trigger` is the schedule that fired, or the flow's first schedule for a
     * Run now (`null` when it has none). Answers the outcome; resolving with nothing means it ran.
     */
    readonly run: (flow: FlowRecord, trigger: Schedule | null) => Promise<RunResult | void>;
}

export interface Due {
    readonly flowId: string;
    readonly at: number;
}

export class FlowScheduler {
    readonly #deps: FlowSchedulerDeps;
    #cancel: (() => void) | null = null;
    #next: (Due & { trigger: Schedule }) | null = null;
    /** The flows with a run in flight, each with that run. */
    readonly #running = new Map<string, Promise<FlowRun | null>>();

    constructor(deps: FlowSchedulerDeps) {
        this.#deps = deps;
        // Every change re-plans — an arm, a disarm, an edit, a removal, a recorded run (which leaves the due where it was).
        deps.store.onChange(() => this.plan());
    }

    /** Compute the nearest due across armed flows and hold exactly one timer for it. */
    plan(): void {
        this.#cancel?.();
        this.#cancel = null;
        this.#next = null;
        const now = this.#deps.now();
        for (const flow of this.#deps.store.list()) {
            if (!flow.armed) continue;
            for (const trigger of this.#deps.store.schedules(flow.id)) {
                const at = nextCronAfter(trigger.cron, now, trigger.timezone);
                if (at === null) continue;
                if (this.#next === null || at < this.#next.at) this.#next = { flowId: flow.id, at, trigger };
            }
        }
        if (this.#next) {
            const due = this.#next;
            this.#cancel = this.#deps.schedule(() => this.#fire(due), Math.max(0, due.at - now));
        }
    }

    nextDue(): Due | null {
        return this.#next ? { flowId: this.#next.flowId, at: this.#next.at } : null;
    }

    /** How many flows are executing right now — the Deck's "N flows running" signal. */
    inFlightCount(): number {
        return this.#running.size;
    }

    /** Resolves when no run is in flight — what a host awaits before quitting, and what a test awaits. */
    async settled(): Promise<void> {
        while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()]);
    }

    /**
     * The PERSON's Run now: one run of the flow, armed or not, recorded as `manual`. Answers the run as
     * recorded — `held` when the flow's previous run is still going. Throws for a flow that does not exist.
     */
    async runNow(flowId: string): Promise<FlowRun> {
        const flow = this.#deps.store.get(flowId);
        if (!flow) throw new Error(`no flow ${flowId}`);
        const run = await this.#start(flow, this.#deps.store.schedules(flow.id)[0] ?? null, 'manual');
        if (!run) throw new Error(`flow ${flowId} was removed while it ran`);
        return run;
    }

    #fire(due: Due & { trigger: Schedule }): void {
        this.#cancel = null;
        const flow = this.#deps.store.get(due.flowId);
        // Replan FIRST, so the next due is held whatever the run does — and so a slow run cannot
        // delay the schedule behind it.
        this.plan();
        if (!flow || !flow.armed) return;
        void this.#start(flow, due.trigger, 'schedule');
    }

    #start(flow: FlowRecord, trigger: Schedule | null, kind: FlowRun['trigger']): Promise<FlowRun | null> {
        const startedAt = this.#deps.now();
        if (this.#running.has(flow.id)) {
            return this.#record(flow.id, { trigger: kind, outcome: 'held', reason: `the previous run of "${flow.name}" is still going; this one was not started beside it`, startedAt });
        }
        const run = this.#execute(flow, trigger, kind, startedAt).finally(() => {
            if (this.#running.get(flow.id) === run) this.#running.delete(flow.id);
        });
        this.#running.set(flow.id, run);
        return run;
    }

    async #execute(flow: FlowRecord, trigger: Schedule | null, kind: FlowRun['trigger'], startedAt: number): Promise<FlowRun | null> {
        let result: { outcome: RunOutcome; reason?: string };
        try {
            // Answering nothing means it ran (a run port with nothing to say about its outcome).
            const answered = (await this.#deps.run(flow, trigger)) as RunResult | undefined;
            result = answered ?? { outcome: 'ran' };
        } catch (error) {
            result = { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
        return this.#record(flow.id, { trigger: kind, startedAt, ...result });
    }

    #record(flowId: string, run: { trigger: FlowRun['trigger']; outcome: RunOutcome; reason?: string; startedAt: number }): Promise<FlowRun | null> {
        return this.#deps.store.recordRun(flowId, run);
    }
}
