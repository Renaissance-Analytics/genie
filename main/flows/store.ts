/**
 * Where flows live. ONE table, and scope is a column on it.
 *
 * A flow row is stored graph JSON that Genie will later EXECUTE, which makes it
 * authority-adjacent even though it grants nothing by itself. Two properties
 * follow from that and live in the SCHEMA (migration v74), not in whoever
 * happens to be calling:
 *
 *   - a `gapp`-scoped flow has an `app_id` foreign key with ON DELETE CASCADE,
 *     because a scheduled flow that outlives its app is the thing that keeps
 *     firing after the user thought they had removed it;
 *   - a `system` or `workspace` flow has no `app_id` at all, because there is no
 *     app whose grant it acts under. It acts as the USER.
 *
 * ## Scope is not a permission
 *
 * It says who a flow belongs to and who lists it — noise reduction, so an
 * agent's reasoning is not polluted by automation it has no business acting on.
 * What a flow may DO is `decideFlowAdmission`'s answer, read off the grant.
 * Nothing security-bearing may be built on scope.
 *
 * ## Reading a stored row never throws
 *
 * A row can be hand-edited, half-written, or migrated from a shape that no
 * longer parses. Whatever is listing flows must not fall over because one of
 * them is corrupt, so a bad graph reads back as `null` and a bad scope as
 * `null` — and both are refused downstream rather than guessed at. A flow whose
 * scope Genie cannot read is emphatically not a flow to run "as system".
 *
 * ## Why every function takes a `Database`
 *
 * The `*In` functions are the real implementation and take the connection, so
 * the suite can exercise them against a real in-memory better-sqlite3. The
 * exported wrappers bind Genie's singleton. Same code both ways — there is no
 * test-only path that could pass while production differs.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { armableSchedules } from './triggers';
import type { FlowGraphLike } from './admission';
import { owningAppOf, parseFlowScope, type FlowScope } from './types';

export interface FlowRow {
    id: string;
    /** The owning app, for a `gapp` flow. Null for every other scope. */
    appId: string | null;
    title: string;
    /** What the flow is FOR. The menu groups by it, so it is stored, not guessed. */
    purpose: string;
    description?: string;
    /** The stored scope, or null when it could not be read. */
    scope: FlowScope | null;
    /** The stored graph, or null when it could not be parsed. */
    graph: FlowGraphLike | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface FlowInput {
    id: string;
    title: string;
    scope: FlowScope;
    graph: unknown;
    purpose?: string;
    description?: string;
    /**
     * Default FALSE. A new flow is born disarmed.
     *
     * Arming one hands it standing permission to act unattended, and that is a
     * separate decision from creating it — made once the author can see what the
     * flow actually does. Defaulting to true here would make creation a second
     * door onto the same thing.
     */
    enabled?: boolean;
}

/** A flow with a schedule Genie should arm, flattened for the scheduler. */
export interface ScheduledFlow {
    flowId: string;
    appId: string | null;
    title: string;
    /** The trigger node that declared it — a graph may hold more than one. */
    nodeId: string;
    cron: string;
}

interface RawFlow {
    id: string;
    app_id: string | null;
    title: string;
    purpose: string;
    description: string | null;
    scope_json: string;
    graph_json: string;
    enabled: number;
    created_at: string;
    updated_at: string;
}

const COLUMNS =
    'id, app_id, title, purpose, description, scope_json, graph_json, enabled, created_at, updated_at';

function parseJson(json: string): unknown {
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function parseGraph(json: string): FlowGraphLike | null {
    const parsed = parseJson(json);
    return parsed && typeof parsed === 'object' ? (parsed as FlowGraphLike) : null;
}

function toFlow(raw: RawFlow): FlowRow {
    return {
        id: raw.id,
        appId: raw.app_id,
        title: raw.title,
        purpose: raw.purpose,
        ...(raw.description !== null ? { description: raw.description } : {}),
        scope: parseFlowScope(parseJson(raw.scope_json)),
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

/**
 * Every flow, grouped the way the manager reads: by purpose, then title.
 *
 * Ordered in SQL rather than in whoever is rendering, so the list and the run
 * drawer and the MCP tool cannot each pick their own order and disagree about
 * which flow is "the first one".
 */
export function listFlowsIn(d: Database.Database): FlowRow[] {
    return d
        .prepare<[], RawFlow>(`SELECT ${COLUMNS} FROM flows ORDER BY purpose, title`)
        .all()
        .map(toFlow);
}

/**
 * The flows a given vantage point may SEE.
 *
 * - a GApp sees only its own;
 * - a workspace sees its own plus every `system` flow;
 * - the machine's own surfaces see everything.
 *
 * A flow whose scope could not be read is visible ONLY from the machine-wide
 * vantage. Hiding it entirely would leave the user with a row they cannot find
 * to repair, and showing it inside a workspace or an app would put it somewhere
 * it may not belong.
 */
export function listFlowsVisibleToIn(
    d: Database.Database,
    vantage: { kind: 'system' } | { kind: 'workspace'; workspaceId: string } | { kind: 'gapp'; appId: string },
): FlowRow[] {
    return listFlowsIn(d).filter((flow) => {
        if (vantage.kind === 'system') return true;
        if (!flow.scope) return false;
        if (vantage.kind === 'gapp') {
            return flow.scope.kind === 'gapp' && flow.scope.appId === vantage.appId;
        }
        if (flow.scope.kind === 'system') return true;
        return flow.scope.kind === 'workspace' && flow.scope.workspaceId === vantage.workspaceId;
    });
}

export function upsertFlowIn(d: Database.Database, input: FlowInput): void {
    const now = new Date().toISOString();
    d.prepare(
        `INSERT INTO flows (id, app_id, title, purpose, description, scope_json, graph_json, enabled, created_at, updated_at)
         VALUES (@id, @app_id, @title, @purpose, @description, @scope_json, @graph_json, @enabled, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
             app_id      = excluded.app_id,
             title       = excluded.title,
             purpose     = excluded.purpose,
             description = excluded.description,
             scope_json  = excluded.scope_json,
             graph_json  = excluded.graph_json,
             enabled     = excluded.enabled,
             updated_at  = excluded.updated_at`,
    ).run({
        id: input.id,
        // Derived from the scope, never taken from the caller. Two fields that
        // must agree are two fields that eventually do not, and the one that
        // matters here is the uninstall cascade: a `gapp` flow whose `app_id`
        // was omitted would survive its app being removed and keep firing.
        app_id: owningAppOf(input.scope),
        title: input.title,
        purpose: input.purpose ?? 'Automation',
        description: input.description ?? null,
        scope_json: JSON.stringify(input.scope),
        graph_json: JSON.stringify(input.graph ?? {}),
        enabled: input.enabled === true ? 1 : 0,
        now,
    });
}

export function setFlowEnabledIn(d: Database.Database, id: string, enabled: boolean): void {
    d.prepare('UPDATE flows SET enabled = ?, updated_at = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        new Date().toISOString(),
        id,
    );
}

export function deleteFlowIn(d: Database.Database, id: string): void {
    d.prepare('DELETE FROM flows WHERE id = ?').run(id);
}

/**
 * Every flow whose graph declares a schedule Genie will actually arm.
 *
 * Four exclusions, all of them the difference between a timer that should exist
 * and one that should not:
 *
 *   - `enabled = 0` — the user turned it off;
 *   - a REVOKED app, for a `gapp` flow — revocation is total, and leaving the
 *     timer armed would mean firing every night purely to be refused;
 *   - an unparseable graph or an invalid cron — arming a guess about when
 *     something runs is worse than plainly not running it;
 *   - an unreadable SCOPE — Genie cannot say whose authority the run would
 *     carry, and a timer it cannot explain is one it should not set.
 */
export function listScheduledFlowsIn(d: Database.Database): ScheduledFlow[] {
    const revoked = new Set(
        d
            .prepare<[], { app_id: string }>('SELECT app_id FROM app_grants WHERE revoked = 1')
            .all()
            .map((r) => r.app_id),
    );

    return listFlowsIn(d).flatMap((flow) => {
        if (!flow.enabled || !flow.graph || !flow.scope) return [];
        if (flow.scope.kind === 'gapp' && revoked.has(flow.scope.appId)) return [];
        return armableSchedules(flow.graph).map((s) => ({
            flowId: flow.id,
            appId: flow.appId,
            title: flow.title,
            nodeId: s.nodeId,
            cron: s.cron,
        }));
    });
}

export const getFlow = (id: string): FlowRow | null => getFlowIn(getDb(), id);
export const listFlows = (): FlowRow[] => listFlowsIn(getDb());
export const listFlowsVisibleTo = (
    vantage: Parameters<typeof listFlowsVisibleToIn>[1],
): FlowRow[] => listFlowsVisibleToIn(getDb(), vantage);
export const upsertFlow = (input: FlowInput): void => upsertFlowIn(getDb(), input);
export const setFlowEnabled = (id: string, enabled: boolean): void =>
    setFlowEnabledIn(getDb(), id, enabled);
export const deleteFlow = (id: string): void => deleteFlowIn(getDb(), id);
export const listScheduledFlows = (): ScheduledFlow[] => listScheduledFlowsIn(getDb());
