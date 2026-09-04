/**
 * Where Flows live.
 *
 * A Flow row is data Genie will later ACT ON, unattended. So the interesting
 * property is not that a round trip works — it is that a Flow which could never
 * fire is REFUSED at the point of saving, against the same registry the
 * dispatcher will consult.
 *
 * Refusing late (or not at all) produces the worst failure this feature has: a
 * Flow that sits in a list looking armed, does nothing forever, and gives nobody
 * a reason. `sizeBtyes > 5MB` must be a save error, not a silent night.
 *
 * Exercised against a real in-memory better-sqlite3 — migrations and SQL run for
 * real, so the fixture cannot be laxer than production.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { createFlowEventRegistry } from '../events';
import {
    deleteFlowIn,
    getFlowIn,
    listFlowsIn,
    setFlowEnabledIn,
    upsertFlowIn,
    validateFlow,
} from '../store';
import type { Flow, FlowScope } from '../types';

function db() {
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    runMigrations(d);
    return d;
}

const registry = createFlowEventRegistry();

function flow(over: Partial<Flow> = {}): Flow {
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

describe('the flows table', () => {
    it('round-trips a Flow with all of its parts intact', () => {
        const d = db();
        upsertFlowIn(d, flow(), registry);
        const back = getFlowIn(d, 'w1');
        expect(back).toEqual(flow());
    });

    it('updates in place rather than accumulating rows', () => {
        const d = db();
        upsertFlowIn(d, flow(), registry);
        upsertFlowIn(d, flow({ title: 'Renamed' }), registry);
        expect(listFlowsIn(d)).toHaveLength(1);
        expect(getFlowIn(d, 'w1')?.title).toBe('Renamed');
    });

    it('disables without deleting, because that is what a pause is', () => {
        const d = db();
        upsertFlowIn(d, flow(), registry);
        setFlowEnabledIn(d, 'w1', false);
        expect(getFlowIn(d, 'w1')?.enabled).toBe(false);
        setFlowEnabledIn(d, 'w1', true);
        expect(getFlowIn(d, 'w1')?.enabled).toBe(true);
    });

    it('deletes', () => {
        const d = db();
        upsertFlowIn(d, flow(), registry);
        deleteFlowIn(d, 'w1');
        expect(getFlowIn(d, 'w1')).toBeNull();
        expect(listFlowsIn(d)).toEqual([]);
    });

    it('lists grouped by purpose then title, which is how the menu will read', () => {
        const d = db();
        upsertFlowIn(d, flow({ id: 'b', purpose: 'Files', title: 'Zebra' }), registry);
        upsertFlowIn(d, flow({ id: 'c', purpose: 'Agents', title: 'Alpha' }), registry);
        upsertFlowIn(d, flow({ id: 'a', purpose: 'Files', title: 'Aardvark' }), registry);
        expect(listFlowsIn(d).map((w) => `${w.purpose}/${w.title}`)).toEqual([
            'Agents/Alpha',
            'Files/Aardvark',
            'Files/Zebra',
        ]);
    });
});

describe('validateFlow', () => {
    it('accepts the reference-case Flow', () => {
        expect(validateFlow(flow(), registry)).toEqual([]);
    });

    it('refuses a Flow with no trigger — nothing could ever start it', () => {
        expect(validateFlow(flow({ triggers: [] }), registry)).toContainEqual(
            expect.stringContaining('at least one trigger'),
        );
    });

    it('refuses a trigger naming an event nothing emits', () => {
        const errors = validateFlow(
            flow({ triggers: [{ kind: 'event', event: 'files:teleported' }] }),
            registry,
        );
        expect(errors.join(' ')).toContain('files:teleported');
    });

    it('refuses a filter on a prop the event does not emit — the misspelling case', () => {
        const errors = validateFlow(
            flow({
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
        const errors = validateFlow(
            flow({
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

    it('refuses a Flow with no purpose, because the menu groups by it', () => {
        expect(validateFlow(flow({ purpose: '' }), registry)).toContainEqual(
            expect.stringContaining('purpose'),
        );
    });

    it('refuses a GApp Flow that names no GApp', () => {
        // `gapp` scope IS the ownership AND the visibility (genie#394), so the
        // app id is the whole of it. Without one the Flow is visible to nobody
        // and owned by nobody.
        const errors = validateFlow(
            flow({ scope: { kind: 'gapp', appId: '' } }),
            registry,
        );
        expect(errors.join(' ')).toContain('appId');
    });

    it('refuses a scope word that is no longer a scope', () => {
        // The ladder is system / workspace / gapp. A stored `workstation` or
        // `app` scope is a v66 shape that v67 migrated; one arriving here now
        // is a caller that did not get the memo, and must not be saved as an
        // unreachable Flow.
        const errors = validateFlow(
            flow({ scope: { kind: 'workstation' } as unknown as FlowScope }),
            registry,
        );
        expect(errors.join(' ')).toContain('workstation');
    });
});

describe('saving refuses what validation refuses', () => {
    it('throws rather than storing a Flow that can never fire', () => {
        const d = db();
        expect(() =>
            upsertFlowIn(
                d,
                flow({
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
        expect(listFlowsIn(d)).toEqual([]);
    });

    it('reads back a row whose JSON is unusable as null rather than throwing', () => {
        // A row can be hand-edited or migrated from a shape that no longer
        // parses. Listing Flows must not fall over because one of them is
        // corrupt — `main/apps/flows/store.ts` states the same rule for graphs.
        const d = db();
        upsertFlowIn(d, flow(), registry);
        d.prepare(`UPDATE flows SET triggers_json = '{not json' WHERE id = 'w1'`).run();
        expect(getFlowIn(d, 'w1')).toBeNull();
        expect(listFlowsIn(d)).toEqual([]);
    });
});
