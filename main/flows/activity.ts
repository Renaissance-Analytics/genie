/**
 * What is running right now, and what a finished run amounts to. PURE.
 *
 * The Flow Manager's header button animates off this, so its correctness is a
 * UX property rather than bookkeeping: a badge that claims something is running
 * when nothing is teaches the user to ignore the badge, which is worse than not
 * having one.
 *
 * ## Keyed by RUN, reported by FLOW
 *
 * Two runs of the same Flow can overlap — `FlowRuntime.emit` starts every
 * matching Flow's run together, and a second event can arrive while the first
 * is still going. A set of flow ids would go dark the moment either finished,
 * with work still in flight. So live runs are held by run id and the flow ids
 * are derived, which is the difference between "is anything happening" and "did
 * the most recent thing happen to end".
 *
 * ## Every start is closed, including the ones that failed
 *
 * `FlowRuntime` logs `failed` for a body that threw, and that log arrives here
 * exactly like a success. Nothing in this module distinguishes them, on purpose:
 * a tracker that only cleared on the happy path is how an animation ends up
 * spinning forever after one broken recipe.
 *
 * ## A finish with no start is not an error
 *
 * `blocked`, `refused` and `error` are logged for Flows whose bodies were never
 * entered — the loop guard held them, admission refused them, their recipe is
 * missing. Those are real history and are recorded, but they never made the
 * header move. The tracker reports them as instantaneous rather than inventing a
 * duration it does not have.
 */

import type { FlowRunLog, FlowRunStart } from './runtime';

/** One finished run, as the manager shows it and the store keeps it. */
export interface FlowRunRecord {
    runId: string;
    flowId: string;
    event?: string;
    outcome: FlowRunLog['outcome'];
    reason?: string;
    startedAt: number;
    finishedAt: number;
}

export class FlowActivity {
    /** Live runs by run id → when they began. */
    private readonly live = new Map<string, FlowRunStart>();

    started(start: FlowRunStart): void {
        this.live.set(start.runId, start);
    }

    /**
     * Close a run and produce the record of it.
     *
     * The start is removed BEFORE the record is built, so a duplicate log for
     * the same run id cannot re-use a stale start and report a run that lasted
     * from then until now.
     */
    finished(log: FlowRunLog): FlowRunRecord {
        const start = this.live.get(log.runId);
        this.live.delete(log.runId);

        return {
            runId: log.runId,
            flowId: log.flowId,
            ...(log.event !== undefined ? { event: log.event } : {}),
            outcome: log.outcome,
            ...(log.reason !== undefined ? { reason: log.reason } : {}),
            // No start means nothing ever ran, so there is no elapsed time to
            // report. Zero is the honest answer; a made-up one is the manager
            // asserting something it does not know.
            startedAt: start?.at ?? log.at,
            finishedAt: log.at,
        };
    }

    /** The Flows with at least one run in flight, id-sorted for a stable render. */
    runningFlowIds(): string[] {
        return [...new Set([...this.live.values()].map((s) => s.flowId))].sort();
    }

    /** True when anything at all is running — what the header animates on. */
    isBusy(): boolean {
        return this.live.size > 0;
    }
}
