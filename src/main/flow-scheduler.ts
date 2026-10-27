import { nextCronAfter } from '../core/cron.js';
import { matchesFileTrigger, type FileAddedProps, type FileTriggerConfig } from '../core/file-trigger.js';
import type { NodeOutcome } from '../core/flow-canvas.js';
import type { RunObserver, RunResume } from './flow-runner.js';
import type { FileFired, FlowRecord, FlowRun, FlowRunStep, FlowStore, RunOutcome, Schedule } from './flow-store.js';

/**
 * FLOWS (§6.6) — the scheduler. ONE timer, set to the nearest due among the ARMED flows'
 * schedule triggers; when it fires, EVERY armed flow due at that instant runs and the timer is set
 * again. Never a poll: nothing ticks, nothing scans on an interval. The store's `onChange` is what
 * re-plans — an arm, a disarm, a document edit, a removal.
 *
 * ## One timer, every flow due at it
 *
 * The timer is one; the flows it fires are all of those due at its instant. Two flows on `* * * * *`
 * are due at the same minute, and both run — the timer is a wake-up, not a choice of which flow wins.
 * (Before this, the timer held ONE flow: the first armed flow in the store's order took every tie, so
 * a second flow on the same schedule was armed and never ran — the Windows acceptance's 2b, 2026-10-15.)
 * A flow with several triggers due at the same instant runs once, from the first of them.
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

export type RunResult = { readonly outcome: 'ran' } | { readonly outcome: 'failed' | 'held'; readonly reason: string; readonly steps?: readonly FlowRunStep[] };

export interface FlowSchedulerDeps {
    readonly store: FlowStore;
    readonly now: () => number;
    /** Run `fn` after `ms`; returns a cancel. Injected so tests drive time. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
    /**
     * Execute one run of a flow. `trigger` is the schedule that fired, or the flow's first schedule for a
     * Run now (`null` when it has none). Answers the outcome; resolving with nothing means it ran.
     */
    readonly run: (flow: FlowRecord, trigger: Schedule | FileFired | null, observer?: RunObserver, resume?: RunResume) => Promise<RunResult | void>;
}

export interface Due {
    readonly flowId: string;
    readonly at: number;
}

/** One flow due at the planned instant, with the trigger that makes it due. */
interface DueFlow {
    readonly flowId: string;
    readonly trigger: Schedule;
}

/** The planned instant and every armed flow due at it, in the store's order. */
interface Planned {
    readonly at: number;
    readonly flows: readonly DueFlow[];
}

export class FlowScheduler {
    readonly #deps: FlowSchedulerDeps;
    #cancel: (() => void) | null = null;
    #next: Planned | null = null;
    /** The flows with a run in flight, each with that run. */
    readonly #running = new Map<string, Promise<FlowRun | null>>();

    constructor(deps: FlowSchedulerDeps) {
        this.#deps = deps;
        // Every change re-plans — an arm, a disarm, an edit, a removal, a recorded run (which leaves the due where it was).
        deps.store.onChange(() => this.plan());
    }

    /** Compute the nearest due across armed flows — and every flow due at it — and hold exactly one timer for it. */
    plan(): void {
        this.#cancel?.();
        this.#cancel = null;
        this.#next = null;
        const now = this.#deps.now();
        let at: number | null = null;
        let flows: DueFlow[] = [];
        for (const flow of this.#deps.store.list()) {
            if (!flow.armed) continue;
            // This flow's own nearest due: its first trigger at its earliest instant (one run per flow per instant).
            let mine: { at: number; trigger: Schedule } | null = null;
            for (const trigger of this.#deps.store.schedules(flow.id)) {
                const t = nextCronAfter(trigger.cron, now, trigger.timezone);
                if (t !== null && (mine === null || t < mine.at)) mine = { at: t, trigger };
            }
            if (mine === null) continue;
            if (at === null || mine.at < at) {
                at = mine.at;
                flows = [{ flowId: flow.id, trigger: mine.trigger }];
            } else if (mine.at === at) {
                flows.push({ flowId: flow.id, trigger: mine.trigger });
            }
        }
        if (at !== null) {
            const due: Planned = { at, flows };
            this.#next = due;
            this.#cancel = this.#deps.schedule(() => this.#fire(due), Math.max(0, at - now));
        }
    }

    /** The nearest due: its instant and the first flow (in the store's order) due at it — every flow due then runs. */
    nextDue(): Due | null {
        return this.#next ? { flowId: this.#next.flows[0]!.flowId, at: this.#next.at } : null;
    }

    /**
     * AT LAUNCH: the runs Genie quit under whose interrupted steps are safe to run again (flow-store.ts `resumable`)
     * RESUME from those steps — the steps already done are not run again; their outputs are handed on as they were — and
     * are recorded `resumed` (genie#1204). The others were recorded stopped when the store opened.
     */
    async resumeInterrupted(): Promise<void> {
        for (const flow of this.#deps.store.interrupted()) {
            const going = flow.inFlight!;
            if (this.#running.has(flow.id)) continue;
            const entry = going.entry;
            const schedule = entry ? this.#deps.store.schedules(flow.id).find((s) => s.nodeId === entry) ?? null : null;
            const trigger: Schedule | FileFired | null = schedule ?? (entry && going.trigger === 'file' ? { nodeId: entry, file: { workspaceId: flow.workspaceId, path: '', relPath: going.file ?? '', name: '', extension: '', sizeBytes: 0 } } : null);
            const startedAt = Date.parse(going.at) || this.#deps.now();
            const run = this.#execute(flow, trigger, going.trigger, startedAt, { outputs: going.outputs ?? {} }).finally(() => {
                if (this.#running.get(flow.id) === run) this.#running.delete(flow.id);
            });
            this.#running.set(flow.id, run);
        }
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

    /**
     * A file landed (the file source, genie#1204): every ARMED flow with a `genie/file_added` trigger it matches runs
     * once — from that trigger, with the file — recorded as a `file` run naming it. A disarmed flow never does.
     */
    fileAdded(event: FileAddedProps): void {
        for (const flow of this.#deps.store.list()) {
            if (!flow.armed) continue;
            const hit = this.#deps.store.fileTriggers(flow.id).find((t) => matchesFileTrigger(t.config as unknown as FileTriggerConfig, event));
            if (hit) void this.#start(flow, { nodeId: hit.nodeId, file: event }, 'file');
        }
    }

    #fire(due: Planned): void {
        this.#cancel = null;
        const flows = due.flows.map((d) => ({ flow: this.#deps.store.get(d.flowId), trigger: d.trigger }));
        // Replan FIRST, so the next due is held whatever the runs do — and so a slow run cannot
        // delay the schedule behind it.
        this.plan();
        // Every flow due at this instant, side by side: one's run never waits on, or replaces, another's.
        for (const { flow, trigger } of flows) {
            if (!flow || !flow.armed) continue;
            void this.#start(flow, trigger, 'schedule');
        }
    }

    #start(flow: FlowRecord, trigger: Schedule | FileFired | null, kind: FlowRun['trigger']): Promise<FlowRun | null> {
        const startedAt = this.#deps.now();
        const file = trigger !== null && 'file' in trigger ? { file: trigger.file.relPath } : {};
        if (this.#running.has(flow.id)) {
            return this.#record(flow.id, { trigger: kind, outcome: 'held', reason: `the previous run of "${flow.name}" is still going; this one was not started beside it`, startedAt, ...file });
        }
        const run = this.#execute(flow, trigger, kind, startedAt).finally(() => {
            if (this.#running.get(flow.id) === run) this.#running.delete(flow.id);
        });
        this.#running.set(flow.id, run);
        return run;
    }

    async #execute(flow: FlowRecord, trigger: Schedule | FileFired | null, kind: FlowRun['trigger'], startedAt: number, resume?: RunResume): Promise<FlowRun | null> {
        let result: { outcome: RunOutcome; reason?: string; steps?: readonly FlowRunStep[] };
        // genie#1204: every node's outcome as the run goes — kept on disk while it is in flight, so a quit mid-run is
        // recorded at the next launch rather than lost — and the Log nodes' lines.
        let nodes: Record<string, NodeOutcome> = {};
        const log: string[] = [];
        const outputs: Record<string, unknown> = { ...(resume?.outputs ?? {}) };
        const entry = trigger?.nodeId;
        const at = new Date(startedAt).toISOString();
        const fileOf = trigger !== null && 'file' in trigger ? { file: trigger.file.relPath } : {};
        const observer: RunObserver = {
            nodes: (outcomes) => {
                nodes = outcomes;
                void this.#deps.store.markInFlight(flow.id, { at, trigger: kind, ...fileOf, nodes: outcomes, outputs: { ...outputs }, ...(entry ? { entry } : {}) }).catch(() => {});
            },
            output: (nodeId, value) => { outputs[nodeId] = value; },
            log: (_nodeId, line) => { log.push(line); },
        };
        try {
            // Answering nothing means it ran (a run port with nothing to say about its outcome).
            const answered = (await this.#deps.run(flow, trigger, observer, resume)) as RunResult | undefined;
            result = answered ?? { outcome: 'ran' };
        } catch (error) {
            result = { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
        return this.#record(flow.id, { trigger: kind, startedAt, ...result, ...fileOf, nodes, log, ...(resume ? { resumed: true } : {}) });
    }

    #record(flowId: string, run: { trigger: FlowRun['trigger']; outcome: RunOutcome; reason?: string; startedAt: number; file?: string; steps?: readonly FlowRunStep[]; nodes?: Readonly<Record<string, NodeOutcome>>; log?: readonly string[]; resumed?: boolean }): Promise<FlowRun | null> {
        return this.#deps.store.recordRun(flowId, run);
    }
}
