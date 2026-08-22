/**
 * Where flows live.
 *
 * A flow row is stored graph JSON that Genie will later EXECUTE, which makes it
 * authority-adjacent even though it grants nothing by itself. The two properties
 * that follow from that live in the SCHEMA (migration v44), not in whoever
 * happens to be calling:
 *
 *   - every flow has an app, because a flow with no owner has no grant to be
 *     bounded by and nothing to ask `decideAppCall` about;
 *   - uninstalling an app cascades its flows away, because a scheduled flow that
 *     outlives its app is the thing that keeps firing after the user thought
 *     they had removed it.
 *
 * ## Reading a stored graph never throws
 *
 * A row can be hand-edited, half-written, or migrated from a shape that no longer
 * parses. Whatever is listing flows must not fall over because one of them is
 * corrupt, so a bad graph reads back as `null` and is refused downstream —
 * `decideFlowAdmission` already treats an unreadable graph as unrunnable.
 *
 * ## Why every function takes a `Database`
 *
 * The `*In` functions are the real implementation and take the connection, so the
 * suite can exercise them against a real in-memory better-sqlite3. The exported
 * wrappers bind Genie's singleton. Same code both ways — there is no test-only
 * path that could pass while production differs.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { armableSchedules } from './triggers';
import type { FlowGraphLike } from './admission';

export interface FlowRow {
    id: string;
    appId: string;
    name: string;
    /** The stored graph, or null when it could not be parsed. */
    graph: FlowGraphLike | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface FlowInput {
    id: string;
    appId: string;
    name: string;
    graph: unknown;
    /** Default true. False stops a schedule without deleting the flow. */
    enabled?: boolean;
}

/** A flow with a schedule Genie should arm, flattened for the scheduler. */
export interface ScheduledFlow {
    flowId: string;
    appId: string;
    name: string;
    /** The trigger node that declared it — a graph may hold more than one. */
    nodeId: string;
    cron: string;
}

interface RawFlow {
    id: string;
    app_id: string;
    name: string;
    graph_json: string;
    enabled: number;
    created_at: string;
    updated_at: string;
}

const COLUMNS = 'id, app_id, name, graph_json, enabled, created_at, updated_at';

function parseGraph(json: string): FlowGraphLike | null {
    try {
        const parsed: unknown = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? (parsed as FlowGraphLike) : null;
    } catch {
        return null;
    }
}

function toFlow(raw: RawFlow): FlowRow {
    return {
        id: raw.id,
        appId: raw.app_id,
        name: raw.name,
        graph: parseGraph(raw.graph_json),
        enabled: raw.enabled !== 0,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}

export function getFlowIn(d: Database.Database, id: string): FlowRow | null {
    const raw = d
        .prepare<[string], RawFlow | undefined>(`SELECT ${COLUMNS} FROM flows WHERE id = ?`)
        .get(id);
    return raw ? toFlow(raw) : null;
}

export function listFlowsForAppIn(d: Database.Database, appId: string): FlowRow[] {
    return d
        .prepare<[string], RawFlow>(`SELECT ${COLUMNS} FROM flows WHERE app_id = ? ORDER BY name`)
        .all(appId)
        .map(toFlow);
}

export function upsertFlowIn(d: Database.Database, input: FlowInput): void {
    const now = new Date().toISOString();
    d.prepare(
        `INSERT INTO flows (id, app_id, name, graph_json, enabled, created_at, updated_at)
         VALUES (@id, @app_id, @name, @graph_json, @enabled, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
             name       = excluded.name,
             graph_json = excluded.graph_json,
             enabled    = excluded.enabled,
             updated_at = excluded.updated_at`,
    ).run({
        id: input.id,
        app_id: input.appId,
        name: input.name,
        graph_json: JSON.stringify(input.graph ?? {}),
        enabled: input.enabled === false ? 0 : 1,
        now,
    });
}

export function deleteFlowIn(d: Database.Database, id: string): void {
    d.prepare('DELETE FROM flows WHERE id = ?').run(id);
}

/**
 * Every flow whose graph declares a schedule Genie will actually arm.
 *
 * Three exclusions, all of them the difference between a timer that should exist
 * and one that should not:
 *
 *   - `enabled = 0` — the user turned it off;
 *   - a REVOKED app — revocation is total, and leaving the timer armed would mean
 *     firing every night purely to be refused by the bridge;
 *   - an unparseable graph or an invalid cron — arming a guess about when
 *     something runs is worse than plainly not running it.
 */
export function listScheduledFlowsIn(d: Database.Database): ScheduledFlow[] {
    const rows = d
        .prepare<[], RawFlow>(
            `SELECT f.id, f.app_id, f.name, f.graph_json, f.enabled, f.created_at, f.updated_at
             FROM flows f
             JOIN app_grants g ON g.app_id = f.app_id
             WHERE f.enabled = 1 AND g.revoked = 0
             ORDER BY f.name`,
        )
        .all();

    return rows.flatMap((raw) => {
        const flow = toFlow(raw);
        if (!flow.graph) return [];
        return armableSchedules(flow.graph).map((s) => ({
            flowId: flow.id,
            appId: flow.appId,
            name: flow.name,
            nodeId: s.nodeId,
            cron: s.cron,
        }));
    });
}

export const getFlow = (id: string): FlowRow | null => getFlowIn(getDb(), id);
export const listFlowsForApp = (appId: string): FlowRow[] => listFlowsForAppIn(getDb(), appId);
export const upsertFlow = (input: FlowInput): void => upsertFlowIn(getDb(), input);
export const deleteFlow = (id: string): void => deleteFlowIn(getDb(), id);
export const listScheduledFlows = (): ScheduledFlow[] => listScheduledFlowsIn(getDb());
