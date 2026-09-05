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
 *
 * `validateFlow` itself lives in `authoring.ts` — deciding what may BECOME a
 * Flow is the authoring gate, and the store's job is to refuse anything it
 * rejects. Both halves are exercised here, because the write is where the rule
 * has to hold.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { validateFlow } from '../authoring';
import { resolveBuiltInRecipe } from '../builtin-recipes';
import { createFlowEventRegistry } from '../events';
import {
    deleteFlowIn,
    getFlowIn,
    listFlowsIn,
    setFlowEnabledIn,
    upsertFlowIn,
} from '../store';
import type { Flow, FlowScope } from '../types';

function db() {
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    runMigrations(d);
    return d;
}

const registry = createFlowEventRegistry();
/** The real catalogue: a Flow is judged against the body it actually names. */
const resolve = resolveBuiltInRecipe;

function flow(over: Partial<Flow> = {}): Flow {
    return {
        id: 'w1',
        title: 'Keep the repo light',
        purpose: 'Files',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        enabled: true,
        triggers: [
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
        upsertFlowIn(d, flow(), registry, resolve);
        const back = getFlowIn(d, 'w1');
        expect(back).toEqual(flow());
    });

    it('updates in place rather than accumulating rows', () => {
        const d = db();
        upsertFlowIn(d, flow(), registry, resolve);
        upsertFlowIn(d, flow({ title: 'Renamed' }), registry, resolve);
        expect(listFlowsIn(d)).toHaveLength(1);
        expect(getFlowIn(d, 'w1')?.title).toBe('Renamed');
    });

    it('disables without deleting, because that is what a pause is', () => {
        const d = db();
        upsertFlowIn(d, flow(), registry, resolve);
        setFlowEnabledIn(d, 'w1', false);
        expect(getFlowIn(d, 'w1')?.enabled).toBe(false);
        setFlowEnabledIn(d, 'w1', true);
        expect(getFlowIn(d, 'w1')?.enabled).toBe(true);
    });

    it('deletes', () => {
        const d = db();
        upsertFlowIn(d, flow(), registry, resolve);
        deleteFlowIn(d, 'w1');
        expect(getFlowIn(d, 'w1')).toBeNull();
        expect(listFlowsIn(d)).toEqual([]);
    });

    it('lists grouped by purpose then title, which is how the menu will read', () => {
        const d = db();
        upsertFlowIn(d, flow({ id: 'b', purpose: 'Files', title: 'Zebra' }), registry, resolve);
        upsertFlowIn(d, flow({ id: 'c', purpose: 'Agents', title: 'Alpha' }), registry, resolve);
        upsertFlowIn(d, flow({ id: 'a', purpose: 'Files', title: 'Aardvark' }), registry, resolve);
        expect(listFlowsIn(d).map((w) => `${w.purpose}/${w.title}`)).toEqual([
            'Agents/Alpha',
            'Files/Aardvark',
            'Files/Zebra',
        ]);
    });
});

describe('validateFlow', () => {
    it('accepts the reference-case Flow', () => {
        expect(validateFlow(flow(), registry, resolve)).toEqual([]);
    });

    it('refuses a Flow with no trigger — nothing could ever start it', () => {
        expect(validateFlow(flow({ triggers: [] }), registry, resolve)).toContainEqual(
            expect.stringContaining('at least one trigger'),
        );
    });

    it('refuses a trigger naming an event nothing emits', () => {
        const errors = validateFlow(
            flow({ triggers: [{ kind: 'event', event: 'files:teleported' }] }),
            registry,
            resolve,
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
            resolve,
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
            resolve,
        );
        expect(errors.join(' ')).toContain('relPath');
    });

    it('refuses a Flow with no purpose, because the menu groups by it', () => {
        expect(validateFlow(flow({ purpose: '' }), registry, resolve)).toContainEqual(
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
            resolve,
        );
        expect(errors.join(' ')).toContain('appId');
    });

    it('refuses a Flow whose body does not exist', () => {
        // The runtime already reports this as a refusal at 3am. Saying it at the
        // WRITE is the difference between a typo somebody fixes in the second
        // they made it and a Flow that sits in the list looking armed.
        const errors = validateFlow(
            flow({ recipe: { kind: 'builtin', recipeId: 'genie.relocate-fil' } }),
            registry,
            resolve,
        );
        expect(errors.join(' ')).toContain('genie.relocate-fil');
    });

    it('refuses a manual trigger on a body that reads its file off the event', () => {
        // `genie.relocate-file` declares `relPath` as an input the event
        // supplies. A Flow you press Run on supplies none, so the body throws at
        // its first line — a Run button that could only ever fail.
        const errors = validateFlow(
            flow({ triggers: [{ kind: 'manual' }] }),
            registry,
            resolve,
        );
        expect(errors.join(' ')).toContain('relPath');
    });

    it('accepts that same manual Flow once the values are given as settings', () => {
        // The positive control: the rule above is about a MISSING value, not
        // about manual triggers, and a validator that simply refused every
        // manual Flow would pass the test above too.
        expect(
            validateFlow(
                flow({
                    triggers: [{ kind: 'manual' }],
                    recipe: {
                        kind: 'builtin',
                        recipeId: 'genie.relocate-file',
                        args: { workspacePath: 'C:/repo', relPath: 'big.bin' },
                    },
                }),
                registry,
                resolve,
            ),
        ).toEqual([]);
    });

    it('refuses a scope word that is no longer a scope', () => {
        // The ladder is system / workspace / gapp. A stored `workstation` or
        // `app` scope is a v66 shape that v67 migrated; one arriving here now
        // is a caller that did not get the memo, and must not be saved as an
        // unreachable Flow.
        const errors = validateFlow(
            flow({ scope: { kind: 'workstation' } as unknown as FlowScope }),
            registry,
            resolve,
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
                resolve,
            ),
        ).toThrow(/sizeBtyes/);
        expect(listFlowsIn(d)).toEqual([]);
    });

    it('reads back a row whose JSON is unusable as null rather than throwing', () => {
        // A row can be hand-edited or migrated from a shape that no longer
        // parses. Listing Flows must not fall over because one of them is
        // corrupt — `main/apps/flows/store.ts` states the same rule for graphs.
        const d = db();
        upsertFlowIn(d, flow(), registry, resolve);
        d.prepare(`UPDATE flows SET triggers_json = '{not json' WHERE id = 'w1'`).run();
        expect(getFlowIn(d, 'w1')).toBeNull();
        expect(listFlowsIn(d)).toEqual([]);
    });
});
