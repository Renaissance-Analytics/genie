/**
 * Where Wishes live.
 *
 * A Wish row is data Genie will later ACT ON, unattended. So the interesting
 * property is not that a round trip works — it is that a Wish which could never
 * fire is REFUSED at the point of saving, against the same registry the
 * dispatcher will consult.
 *
 * Refusing late (or not at all) produces the worst failure this feature has: a
 * Wish that sits in a list looking armed, does nothing forever, and gives nobody
 * a reason. `sizeBtyes > 5MB` must be a save error, not a silent night.
 *
 * Exercised against a real in-memory better-sqlite3 — migrations and SQL run for
 * real, so the fixture cannot be laxer than production.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { createWishEventRegistry } from '../events';
import {
    deleteWishIn,
    getWishIn,
    listWishesIn,
    setWishEnabledIn,
    upsertWishIn,
    validateWish,
} from '../store';
import type { Wish } from '../types';

function db() {
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    runMigrations(d);
    return d;
}

const registry = createWishEventRegistry();

function wish(over: Partial<Wish> = {}): Wish {
    return {
        id: 'w1',
        title: 'Keep the repo light',
        purpose: 'Files',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        enabled: true,
        triggers: [
            { kind: 'manual' },
            {
                kind: 'event',
                event: 'files:added',
                filter: { all: [{ prop: 'sizeBytes', op: 'gt', value: 5_242_880 }] },
            },
        ],
        recipe: { kind: 'builtin', recipeId: 'genie.relocate-file', args: { relocateTo: '.big' } },
        ...over,
    };
}

describe('the wishes table', () => {
    it('round-trips a Wish with all of its parts intact', () => {
        const d = db();
        upsertWishIn(d, wish(), registry);
        const back = getWishIn(d, 'w1');
        expect(back).toEqual(wish());
    });

    it('updates in place rather than accumulating rows', () => {
        const d = db();
        upsertWishIn(d, wish(), registry);
        upsertWishIn(d, wish({ title: 'Renamed' }), registry);
        expect(listWishesIn(d)).toHaveLength(1);
        expect(getWishIn(d, 'w1')?.title).toBe('Renamed');
    });

    it('disables without deleting, because that is what a pause is', () => {
        const d = db();
        upsertWishIn(d, wish(), registry);
        setWishEnabledIn(d, 'w1', false);
        expect(getWishIn(d, 'w1')?.enabled).toBe(false);
        setWishEnabledIn(d, 'w1', true);
        expect(getWishIn(d, 'w1')?.enabled).toBe(true);
    });

    it('deletes', () => {
        const d = db();
        upsertWishIn(d, wish(), registry);
        deleteWishIn(d, 'w1');
        expect(getWishIn(d, 'w1')).toBeNull();
        expect(listWishesIn(d)).toEqual([]);
    });

    it('lists grouped by purpose then title, which is how the menu will read', () => {
        const d = db();
        upsertWishIn(d, wish({ id: 'b', purpose: 'Files', title: 'Zebra' }), registry);
        upsertWishIn(d, wish({ id: 'c', purpose: 'Agents', title: 'Alpha' }), registry);
        upsertWishIn(d, wish({ id: 'a', purpose: 'Files', title: 'Aardvark' }), registry);
        expect(listWishesIn(d).map((w) => `${w.purpose}/${w.title}`)).toEqual([
            'Agents/Alpha',
            'Files/Aardvark',
            'Files/Zebra',
        ]);
    });
});

describe('validateWish', () => {
    it('accepts the reference-case Wish', () => {
        expect(validateWish(wish(), registry)).toEqual([]);
    });

    it('refuses a Wish with no trigger — nothing could ever start it', () => {
        expect(validateWish(wish({ triggers: [] }), registry)).toContainEqual(
            expect.stringContaining('at least one trigger'),
        );
    });

    it('refuses a trigger naming an event nothing emits', () => {
        const errors = validateWish(
            wish({ triggers: [{ kind: 'event', event: 'files:teleported' }] }),
            registry,
        );
        expect(errors.join(' ')).toContain('files:teleported');
    });

    it('refuses a filter on a prop the event does not emit — the misspelling case', () => {
        const errors = validateWish(
            wish({
                triggers: [
                    {
                        kind: 'event',
                        event: 'files:added',
                        filter: { all: [{ prop: 'sizeBtyes', op: 'gt', value: 1 }] },
                    },
                ],
            }),
            registry,
        );
        expect(errors.join(' ')).toContain('sizeBtyes');
    });

    it('refuses an operator that cannot be applied to the prop’s type', () => {
        const errors = validateWish(
            wish({
                triggers: [
                    {
                        kind: 'event',
                        event: 'files:added',
                        filter: { all: [{ prop: 'relPath', op: 'gt', value: 5 }] },
                    },
                ],
            }),
            registry,
        );
        expect(errors.join(' ')).toContain('relPath');
    });

    it('refuses a Wish with no purpose, because the menu groups by it', () => {
        expect(validateWish(wish({ purpose: '' }), registry)).toContainEqual(
            expect.stringContaining('purpose'),
        );
    });

    it('refuses a GApp Wish that does not say whether it is exposed', () => {
        const errors = validateWish(
            wish({
                scope: { kind: 'app', appId: 'app-1', exposure: 'nope' as 'internal' },
            }),
            registry,
        );
        expect(errors.join(' ')).toContain('exposure');
    });
});

describe('saving refuses what validation refuses', () => {
    it('throws rather than storing a Wish that can never fire', () => {
        const d = db();
        expect(() =>
            upsertWishIn(
                d,
                wish({
                    triggers: [
                        {
                            kind: 'event',
                            event: 'files:added',
                            filter: { all: [{ prop: 'sizeBtyes', op: 'gt', value: 1 }] },
                        },
                    ],
                }),
                registry,
            ),
        ).toThrow(/sizeBtyes/);
        expect(listWishesIn(d)).toEqual([]);
    });

    it('reads back a row whose JSON is unusable as null rather than throwing', () => {
        // A row can be hand-edited or migrated from a shape that no longer
        // parses. Listing Wishes must not fall over because one of them is
        // corrupt — `main/flows/store.ts` states the same rule for graphs.
        const d = db();
        upsertWishIn(d, wish(), registry);
        d.prepare(`UPDATE wishes SET triggers_json = '{not json' WHERE id = 'w1'`).run();
        expect(getWishIn(d, 'w1')).toBeNull();
        expect(listWishesIn(d)).toEqual([]);
    });
});
