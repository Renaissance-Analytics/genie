/**
 * Where a Flow's runs are kept, so the manager can say what happened.
 *
 * ## Every outcome, not every success
 *
 * `blocked`, `refused` and `error` are stored beside `ran`. `runtime.ts` states
 * the reason and it applies to storage as much as to logging: a Flow silently
 * not firing is the hardest failure in an automation system to debug, and "last
 * outcome: the loop guard held it" is the sentence that makes opening the
 * manager worth doing. A store that kept only successes would show a Flow
 * refused nightly for a week as one that had simply never run.
 *
 * ## The last run of every Flow is ONE query
 *
 * It is a column in a list, so a per-row read would be a query per Flow every
 * time the list repaints — the shape that looks fine with three Flows and is
 * the reason the page is slow with forty. `ROW_NUMBER() OVER (PARTITION BY ...)`
 * answers all of them in one pass, and orders ties by `rowid` so a Flow that ran
 * twice inside one millisecond reports the SECOND one rather than whichever the
 * planner happened to emit.
 *
 * ## Why every function takes a `Database`
 *
 * The `*In` functions are the real implementation and take the connection, so
 * the suite exercises them against a real in-memory better-sqlite3. The exported
 * wrappers bind Genie's singleton. Same code both ways — there is no test-only
 * path that could pass while production differs. `store.ts` beside this one
 * states the same rule.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import type { FlowRunRecord } from './activity';

export type { FlowRunRecord } from './activity';

/**
 * Runs kept per Flow.
 *
 * Enough to see a pattern — "it has failed the last four nights" — without the
 * table becoming the biggest thing in the database on a machine where a file
 * watcher fires all day.
 */
export const FLOW_RUNS_KEPT_PER_FLOW = 50;

interface RawRun {
    run_id: string;
    flow_id: string;
    event: string | null;
    outcome: string;
    reason: string | null;
    started_at: number;
    finished_at: number;
}

const COLUMNS = 'run_id, flow_id, event, outcome, reason, started_at, finished_at';

function toRecord(raw: RawRun): FlowRunRecord {
    return {
        runId: raw.run_id,
        flowId: raw.flow_id,
        ...(raw.event !== null ? { event: raw.event } : {}),
        outcome: raw.outcome as FlowRunRecord['outcome'],
        ...(raw.reason !== null ? { reason: raw.reason } : {}),
        startedAt: raw.started_at,
        finishedAt: raw.finished_at,
    };
}

/**
 * Save one finished run.
 *
 * Upserts on `run_id`: a run has exactly one outcome, and a repeated log for the
 * same id is the same run being reported twice, not a second one.
 */
export function recordFlowRunIn(d: Database.Database, run: FlowRunRecord): void {
    d.prepare(
        `INSERT INTO flow_runs (run_id, flow_id, event, outcome, reason, started_at, finished_at)
         VALUES (@run_id, @flow_id, @event, @outcome, @reason, @started_at, @finished_at)
         ON CONFLICT(run_id) DO UPDATE SET
             flow_id     = excluded.flow_id,
             event       = excluded.event,
             outcome     = excluded.outcome,
             reason      = excluded.reason,
             started_at  = excluded.started_at,
             finished_at = excluded.finished_at`,
    ).run({
        run_id: run.runId,
        flow_id: run.flowId,
        event: run.event ?? null,
        outcome: run.outcome,
        reason: run.reason ?? null,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
    });
}

/** One Flow's history, newest first. */
export function listFlowRunsIn(
    d: Database.Database,
    flowId: string,
    limit = FLOW_RUNS_KEPT_PER_FLOW,
): FlowRunRecord[] {
    return d
        .prepare<[string, number], RawRun>(
            `SELECT ${COLUMNS} FROM flow_runs
             WHERE flow_id = ?
             ORDER BY finished_at DESC, rowid DESC
             LIMIT ?`,
        )
        .all(flowId, limit)
        .map(toRecord);
}

/**
 * The newest run of every Flow that has one, by flow id.
 *
 * A Flow that has never run is simply absent — the manager renders "never run"
 * from the gap rather than from a fabricated row.
 */
export function lastFlowRunsIn(d: Database.Database): Map<string, FlowRunRecord> {
    const rows = d
        .prepare<[], RawRun>(
            `SELECT ${COLUMNS} FROM (
                 SELECT ${COLUMNS},
                        ROW_NUMBER() OVER (
                            PARTITION BY flow_id ORDER BY finished_at DESC, rowid DESC
                        ) AS rn
                 FROM flow_runs
             ) WHERE rn = 1`,
        )
        .all();
    return new Map(rows.map((r) => [r.flow_id, toRecord(r)]));
}

/**
 * Trim every Flow to its most recent `keepPerFlow` runs.
 *
 * Per Flow rather than globally, so one chatty Flow cannot evict a quiet one's
 * entire history — which is exactly the history somebody goes looking for when
 * the quiet one stops working.
 */
export function pruneFlowRunsIn(
    d: Database.Database,
    keepPerFlow = FLOW_RUNS_KEPT_PER_FLOW,
): number {
    const result = d
        .prepare(
            `DELETE FROM flow_runs WHERE run_id IN (
                 SELECT run_id FROM (
                     SELECT run_id,
                            ROW_NUMBER() OVER (
                                PARTITION BY flow_id ORDER BY finished_at DESC, rowid DESC
                            ) AS rn
                     FROM flow_runs
                 ) WHERE rn > ?
             )`,
        )
        .run(keepPerFlow);
    return result.changes;
}

/** Drop one Flow's history — what deleting the Flow itself has to do. */
export function deleteFlowRunsIn(d: Database.Database, flowId: string): void {
    d.prepare('DELETE FROM flow_runs WHERE flow_id = ?').run(flowId);
}

/* ===== bound to Genie's database ======================================= */

export const recordFlowRun = (run: FlowRunRecord): void => recordFlowRunIn(getDb(), run);
export const listFlowRuns = (flowId: string, limit?: number): FlowRunRecord[] =>
    listFlowRunsIn(getDb(), flowId, limit);
export const lastFlowRuns = (): Map<string, FlowRunRecord> => lastFlowRunsIn(getDb());
export const pruneFlowRuns = (keepPerFlow?: number): number =>
    pruneFlowRunsIn(getDb(), keepPerFlow);
export const deleteFlowRuns = (flowId: string): void => deleteFlowRunsIn(getDb(), flowId);
