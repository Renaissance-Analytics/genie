/**
 * Where Wishes live, and what may become one.
 *
 * ## Validation belongs at the WRITE
 *
 * A Wish is judged against the event registry when it is SAVED, not only when it
 * fires. That ordering is the whole reason registry entries declare their props:
 * `sizeBtyes > 5MB` is a typo somebody can fix in the second they made it, and a
 * silent night that nobody can explain if it is only discovered at 3am.
 *
 * The failure this prevents is the specific one automation systems are famous
 * for — a rule sitting in a list looking armed, doing nothing forever, with
 * nothing anywhere looking wrong.
 *
 * ## Reading a stored Wish never throws
 *
 * A row can be hand-edited, half-written, or migrated from a shape that no
 * longer parses. Whatever is listing Wishes must not fall over because one of
 * them is corrupt, so an unreadable row reads back as `null` and is left out of
 * the list — the same rule `main/flows/store.ts` states for graphs. It is
 * skipped rather than run: a Wish nobody can read is a Wish nobody consented to.
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
import type { WishEventRegistry } from './events';
import { validateWishFilter } from './filter';
import type { Wish, WishRecipeRef, WishScope, WishTrigger } from './types';

interface RawWish {
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

/**
 * Everything wrong with this Wish, in one list.
 *
 * All the problems rather than the first: an author fixing a Wish wants the
 * whole list, and reporting one at a time turns a single edit into four rounds.
 */
export function validateWish(wish: Wish, registry: WishEventRegistry): string[] {
    const errors: string[] = [];

    if (!nonEmpty(wish.id)) errors.push('a Wish needs an id.');
    if (!nonEmpty(wish.title)) errors.push('a Wish needs a title.');
    if (!nonEmpty(wish.purpose)) {
        errors.push('a Wish needs a purpose — the menu groups by it, so it cannot be inferred.');
    }
    if (!wish.recipe || wish.recipe.kind !== 'builtin' || !nonEmpty(wish.recipe.recipeId)) {
        errors.push('a Wish needs a body: a recipe id.');
    }

    errors.push(...scopeErrors(wish.scope));

    if (!Array.isArray(wish.triggers) || wish.triggers.length === 0) {
        errors.push('a Wish needs at least one trigger, or nothing could ever start it.');
    } else {
        wish.triggers.forEach((trigger, i) => {
            errors.push(...triggerErrors(trigger, i, registry));
        });
    }

    return errors;
}

function nonEmpty(v: unknown): boolean {
    return typeof v === 'string' && v.trim() !== '';
}

function scopeErrors(scope: WishScope | undefined): string[] {
    if (!scope || typeof scope !== 'object') return ['a Wish needs a scope.'];
    switch (scope.kind) {
        case 'workstation':
            return [];
        case 'workspace':
            return nonEmpty(scope.workspaceId)
                ? []
                : ['a workspace-scoped Wish needs a workspaceId.'];
        case 'app': {
            const out: string[] = [];
            if (!nonEmpty(scope.appId)) out.push('an app-scoped Wish needs an appId.');
            if (scope.exposure !== 'workstation' && scope.exposure !== 'internal') {
                out.push(
                    'an app-scoped Wish needs an exposure of "workstation" or "internal" — ' +
                        'an internal Wish appears in no menu outside its GApp, so the answer ' +
                        'cannot be left open.',
                );
            }
            return out;
        }
        default:
            return [`unknown scope "${String((scope as { kind?: unknown }).kind)}".`];
    }
}

function triggerErrors(trigger: WishTrigger, i: number, registry: WishEventRegistry): string[] {
    const where = `triggers[${i}]`;
    if (!trigger || typeof trigger !== 'object') return [`${where} is not a trigger.`];
    if (trigger.kind === 'manual') return [];
    if (trigger.kind !== 'event') {
        return [`${where}: unknown trigger kind "${String((trigger as { kind?: unknown }).kind)}".`];
    }
    const def = registry.get(trigger.event);
    if (!def) {
        return [
            `${where}: nothing emits "${trigger.event}". ` +
                `Known events: ${registry.list().map((d) => d.id).join(', ') || '(none)'}.`,
        ];
    }
    return validateWishFilter(trigger.filter, def).map((e) => `${where}: ${e}`);
}

/* ===== reading ========================================================= */

function parse<T>(json: string): T | null {
    try {
        const value: unknown = JSON.parse(json);
        return value && typeof value === 'object' ? (value as T) : null;
    } catch {
        return null;
    }
}

/** `null` when the row cannot be read back as a Wish. Never throws. */
function toWish(raw: RawWish): Wish | null {
    const scope = parse<WishScope>(raw.scope_json);
    const triggers = parse<WishTrigger[]>(raw.triggers_json);
    const recipe = parse<WishRecipeRef>(raw.recipe_json);
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

export function getWishIn(d: Database.Database, id: string): Wish | null {
    const raw = d
        .prepare<[string], RawWish | undefined>(`SELECT ${COLUMNS} FROM wishes WHERE id = ?`)
        .get(id);
    return raw ? toWish(raw) : null;
}

/**
 * Every readable Wish, ordered by purpose then title — the order the grouped
 * menu wants, decided once here rather than re-sorted by each surface.
 */
export function listWishesIn(d: Database.Database): Wish[] {
    return d
        .prepare<[], RawWish>(`SELECT ${COLUMNS} FROM wishes ORDER BY purpose, title`)
        .all()
        .map(toWish)
        .filter((w): w is Wish => w !== null);
}

/* ===== writing ========================================================= */

/** Save a Wish. Throws with every problem when it could never fire. */
export function upsertWishIn(
    d: Database.Database,
    wish: Wish,
    registry: WishEventRegistry,
): void {
    const errors = validateWish(wish, registry);
    if (errors.length > 0) {
        throw new Error(`Cannot save Wish "${wish.id}": ${errors.join(' ')}`);
    }

    const now = new Date().toISOString();
    d.prepare(
        `INSERT INTO wishes (id, title, purpose, description, scope_json, triggers_json,
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
        id: wish.id,
        title: wish.title,
        purpose: wish.purpose,
        description: wish.description ?? null,
        scope_json: JSON.stringify(wish.scope),
        triggers_json: JSON.stringify(wish.triggers),
        recipe_json: JSON.stringify(wish.recipe),
        enabled: wish.enabled ? 1 : 0,
        now,
    });
}

/** Stop a Wish firing without losing how it was configured. */
export function setWishEnabledIn(d: Database.Database, id: string, enabled: boolean): void {
    d.prepare('UPDATE wishes SET enabled = ?, updated_at = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        new Date().toISOString(),
        id,
    );
}

export function deleteWishIn(d: Database.Database, id: string): void {
    d.prepare('DELETE FROM wishes WHERE id = ?').run(id);
}

/* ===== bound to Genie's database ======================================= */

export const getWish = (id: string): Wish | null => getWishIn(getDb(), id);
export const listWishes = (): Wish[] => listWishesIn(getDb());
export const upsertWish = (wish: Wish, registry: WishEventRegistry): void =>
    upsertWishIn(getDb(), wish, registry);
export const setWishEnabled = (id: string, enabled: boolean): void =>
    setWishEnabledIn(getDb(), id, enabled);
export const deleteWish = (id: string): void => deleteWishIn(getDb(), id);
