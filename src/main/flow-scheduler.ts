import { nextCronAfter } from '../core/cron.js';
import type { FlowRecord, FlowStore, Schedule } from './flow-store.js';

/**
 * FLOWS (§6.6) — the scheduler. ONE timer, set to the nearest due among the ARMED flows'
 * schedule triggers; when it fires, the flow runs and the timer is set again. Never a poll:
 * nothing ticks, nothing scans on an interval. The store's `onChange` is what re-plans — an arm,
 * a disarm, a document edit, a removal.
 *
 * A run that throws is recorded on the flow (`lastRun`) and does not stop the schedule: the
 * next due is planned regardless, because a flow that silently stops firing after one bad
 * night is the failure a scheduler exists to prevent.
 */

export interface FlowSchedulerDeps {
    readonly store: FlowStore;
    readonly now: () => number;
    /** Run `fn` after `ms`; returns a cancel. Injected so tests drive time. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
    readonly run: (flow: FlowRecord, trigger: Schedule) => Promise<void>;
}

export interface Due {
    readonly flowId: string;
    readonly at: number;
}

export class FlowScheduler {
    readonly #deps: FlowSchedulerDeps;
    #cancel: (() => void) | null = null;
    #next: (Due & { trigger: Schedule }) | null = null;
    #planning = false;
    #inFlight: Promise<void> | null = null;

    constructor(deps: FlowSchedulerDeps) {
        this.#deps = deps;
        deps.store.onChange(() => {
            if (!this.#planning) this.plan();
        });
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

    /** Resolves when no run is in flight — what a host awaits before quitting, and what a test awaits. */
    settled(): Promise<void> {
        return this.#inFlight ?? Promise.resolve();
    }

    #fire(due: Due & { trigger: Schedule }): void {
        this.#cancel = null;
        const run = this.#execute(due).finally(() => {
            if (this.#inFlight === run) this.#inFlight = null;
        });
        this.#inFlight = run;
    }

    async #execute(due: Due & { trigger: Schedule }): Promise<void> {
        const flow = this.#deps.store.get(due.flowId);
        // Replan FIRST, so the next due is held whatever the run does — and so a slow run cannot
        // delay the schedule behind it.
        this.plan();
        if (!flow || !flow.armed) return;
        this.#planning = true;
        try {
            await this.#deps.run(flow, due.trigger);
            await this.#deps.store.recordRun(flow.id, { ok: true });
        } catch (error) {
            await this.#deps.store.recordRun(flow.id, { ok: false, error: (error as Error).message });
        } finally {
            this.#planning = false;
        }
    }
}
