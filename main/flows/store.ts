/**
 * Where Flows live, and what may become one.
 *
 * ## Validation belongs at the WRITE
 *
 * A Flow is judged against the event registry when it is SAVED, not only when it
 * fires. That ordering is the whole reason registry entries declare their props:
 * `sizeBtyes > 5MB` is a typo somebody can fix in the second they made it, and a
 * silent night that nobody can explain if it is only discovered at 3am.
 *
 * The failure this prevents is the specific one automation systems are famous
 * for — a rule sitting in a list looking armed, doing nothing forever, with
 * nothing anywhere looking wrong.
 *
 * ## Reading a stored Flow never throws
 *
 * A row can be hand-edited, half-written, or migrated from a shape that no
 * longer parses. Whatever is listing Flows must not fall over because one of
 * them is corrupt, so an unreadable row reads back as `null` and is left out of
 * the list — the same rule `main/apps/flows/store.ts` states for graphs. It is
 * skipped rather than run: a Flow nobody can read is a Flow nobody consented to.
 *
 * ## Why every function takes a `Database`
 *
 * The `*In` functions are the real implementation and take the connection, so
 * the suite exercises them against a real in-memory better-sqlite3. The exported
 * wrappers bind Genie's singleton. Same code both ways — there is no test-only
 * path that could pass while production differs.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { validateFlow, type FlowRecipeResolver } from './authoring';
import { resolveBuiltInRecipe } from './builtin-recipes';
import type { FlowEventRegistry } from './events';
import type { Flow, FlowRecipeRef, FlowScope, FlowTrigger } from './types';

interface RawFlow {
    id: string;
    title: string;
    purpose: string;
    description: string | null;
    scope_json: string;
    triggers_json: string;
    recipe_json: string;
    enabled: number;
    created_at: string;
    updated_at: string;
}

const COLUMNS =
    'id, title, purpose, description, scope_json, triggers_json, recipe_json, enabled, created_at, updated_at';

/* ===== reading ========================================================= */

function parse<T>(json: string): T | null {
    try {
        const value: unknown = JSON.parse(json);
        return value && typeof value === 'object' ? (value as T) : null;
    } catch {
        return null;
    }
}

/** `null` when the row cannot be read back as a Flow. Never throws. */
function toFlow(raw: RawFlow): Flow | null {
    const scope = parse<FlowScope>(raw.scope_json);
    const triggers = parse<FlowTrigger[]>(raw.triggers_json);
    const recipe = parse<FlowRecipeRef>(raw.recipe_json);
    if (!scope || !Array.isArray(triggers) || !recipe) return null;

    return {
        id: raw.id,
        title: raw.title,
        purpose: raw.purpose,
        ...(raw.description ? { description: raw.description } : {}),
        scope,
        triggers,
        recipe,
        enabled: raw.enabled !== 0,
    };
}

export function getFlowIn(d: Database.Database, id: string): Flow | null {
    const raw = d
        .prepare<[string], RawFlow | undefined>(`SELECT ${COLUMNS} FROM flows WHERE id = ?`)
        .get(id);
    return raw ? toFlow(raw) : null;
}

/**
 * Every readable Flow, ordered by purpose then title — the order the grouped
 * menu wants, decided once here rather than re-sorted by each surface.
 */
export function listFlowsIn(d: Database.Database): Flow[] {
    return d
        .prepare<[], RawFlow>(`SELECT ${COLUMNS} FROM flows ORDER BY purpose, title`)
        .all()
        .map(toFlow)
        .filter((w): w is Flow => w !== null);
}

/* ===== writing ========================================================= */

/** Save a Flow. Throws with every problem when it could never fire. */
export function upsertFlowIn(
    d: Database.Database,
    flow: Flow,
    registry: FlowEventRegistry,
    resolveRecipe: FlowRecipeResolver,
): void {
    const errors = validateFlow(flow, registry, resolveRecipe);
    if (errors.length > 0) {
        throw new Error(`Cannot save Flow "${flow.id}": ${errors.join(' ')}`);
    }

    const now = new Date().toISOString();
    d.prepare(
        `INSERT INTO flows (id, title, purpose, description, scope_json, triggers_json,
                             recipe_json, enabled, created_at, updated_at)
         VALUES (@id, @title, @purpose, @description, @scope_json, @triggers_json,
                 @recipe_json, @enabled, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
             title         = excluded.title,
             purpose       = excluded.purpose,
             description   = excluded.description,
             scope_json    = excluded.scope_json,
             triggers_json = excluded.triggers_json,
             recipe_json   = excluded.recipe_json,
             enabled       = excluded.enabled,
             updated_at    = excluded.updated_at`,
    ).run({
        id: flow.id,
        title: flow.title,
        purpose: flow.purpose,
        description: flow.description ?? null,
        scope_json: JSON.stringify(flow.scope),
        triggers_json: JSON.stringify(flow.triggers),
        recipe_json: JSON.stringify(flow.recipe),
        enabled: flow.enabled ? 1 : 0,
        now,
    });
}

/** Stop a Flow firing without losing how it was configured. */
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

/* ===== bound to Genie's database ======================================= */

export const getFlow = (id: string): Flow | null => getFlowIn(getDb(), id);
export const listFlows = (): Flow[] => listFlowsIn(getDb());
export const upsertFlow = (
    flow: Flow,
    registry: FlowEventRegistry,
    resolveRecipe: FlowRecipeResolver = resolveBuiltInRecipe,
): void => upsertFlowIn(getDb(), flow, registry, resolveRecipe);
export const setFlowEnabled = (id: string, enabled: boolean): void =>
    setFlowEnabledIn(getDb(), id, enabled);
export const deleteFlow = (id: string): void => deleteFlowIn(getDb(), id);
