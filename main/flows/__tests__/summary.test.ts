/**
 * What the Flow Manager is handed to draw.
 *
 * The list has to answer, per Flow: who owns it, when it fires, whether it is
 * armed, whether it is running, and what happened last. Assembling that is a
 * join over four sources, and the join is the part with bugs in it — so it lives
 * here, pure, rather than inside a component where the only way to test it is to
 * render one.
 *
 * ## The diagnostic this exists for
 *
 * A Flow whose trigger event is no longer registered can never fire, and looks
 * completely normal in a list: a title, a purpose, `enabled: true`. That is the
 * exact failure `store.ts` refuses at the WRITE — but a Flow saved when an event
 * existed and read back after a plugin stopped registering it slips past that
 * gate, because the gate is on the way in. The summary says so out loud instead
 * of rendering an id nobody recognises next to a green light.
 */

import { describe, expect, it } from 'vitest';
import { createFlowEventRegistry } from '../events';
import { summariseFlows, type SummariseFlowsOptions } from '../summary';
import type { FlowRunRecord } from '../run-store';
import type { Flow } from '../types';

function registry() {
    const r = createFlowEventRegistry();
    r.register({
        id: 'demo:happened',
        label: 'Something happened',
        props: [
            { key: 'note', type: 'string', label: 'Note' },
            { key: 'sizeBytes', type: 'number', label: 'Size in bytes' },
        ],
    });
    return r;
}

function flow(over: Partial<Flow> = {}): Flow {
    return {
        id: 'f1',
        title: 'Keep the repo light',
        purpose: 'Files',
        scope: { kind: 'system' },
        enabled: true,
        triggers: [{ kind: 'manual' }],
        recipe: { kind: 'builtin', recipeId: 'genie.relocate-file' },
        ...over,
    };
}

const run = (over: Partial<FlowRunRecord> = {}): FlowRunRecord => ({
    runId: 'r1',
    flowId: 'f1',
    outcome: 'ran',
    startedAt: 100,
    finishedAt: 400,
    ...over,
});

function summarise(
    flows: Flow[],
    over: Omit<SummariseFlowsOptions, 'registry'> = {},
) {
    return summariseFlows(flows, { registry: registry(), ...over });
}

describe('scope, said in words the list can print', () => {
    it('labels a system Flow as the whole machine', () => {
        const [s] = summarise([flow({ scope: { kind: 'system' } })]);
        expect(s?.scope.kind).toBe('system');
        expect(s?.scopeLabel).toBe('Whole machine');
    });

    it('names the workspace a workspace Flow belongs to', () => {
        const [s] = summarise([flow({ scope: { kind: 'workspace', workspaceId: 'ws-1' } })], {
            workspaceNames: new Map([['ws-1', 'tynn.ai']]),
        });
        expect(s?.scopeLabel).toBe('tynn.ai');
    });

    it('says the workspace is gone rather than printing a raw id', () => {
        const [s] = summarise([flow({ scope: { kind: 'workspace', workspaceId: 'ws-gone' } })], {
            workspaceNames: new Map(),
        });
        // A Flow scoped to a workspace that no longer exists can never see an
        // event — every event it could match carries a different workspace id.
        expect(s?.scopeLabel).toBe('A workspace that no longer exists');
        expect(s?.canEverFire).toBe(false);
    });

    it('names the GApp that owns a gapp-scoped Flow', () => {
        const [s] = summarise([flow({ scope: { kind: 'gapp', appId: 'app-1' } })], {
            appNames: new Map([['app-1', 'Decksmith']]),
        });
        expect(s?.scopeLabel).toBe('Decksmith');
    });
});

describe('triggers, resolved against the registry', () => {
    it('describes a manual trigger', () => {
        const [s] = summarise([flow({ triggers: [{ kind: 'manual' }] })]);
        expect(s?.triggers).toEqual([{ kind: 'manual' }]);
        expect(s?.manuallyRunnable).toBe(true);
    });

    it('resolves an event trigger to its registered label', () => {
        const [s] = summarise([
            flow({ triggers: [{ kind: 'event', event: 'demo:happened' }] }),
        ]);
        expect(s?.triggers).toEqual([
            {
                kind: 'event',
                event: 'demo:happened',
                eventLabel: 'Something happened',
                known: true,
                clauses: [],
            },
        ]);
        expect(s?.manuallyRunnable).toBe(false);
    });

    it('resolves a filter\'s props to their labels', () => {
        const [s] = summarise([
            flow({
                triggers: [
                    {
                        kind: 'event',
                        event: 'demo:happened',
                        filter: {
                            all: [{ prop: 'sizeBytes', op: 'gt', value: 5_242_880 }],
                            none: [{ prop: 'note', op: 'contains', value: 'draft' }],
                        },
                    },
                ],
            }),
        ]);
        const trigger = s?.triggers[0];
        expect(trigger?.kind === 'event' && trigger.clauses).toEqual([
            { group: 'all', prop: 'sizeBytes', propLabel: 'Size in bytes', op: 'gt', value: 5_242_880 },
            { group: 'none', prop: 'note', propLabel: 'Note', op: 'contains', value: 'draft' },
        ]);
    });

    it('flags an event nothing emits, instead of a green light on a dead Flow', () => {
        const [s] = summarise([
            flow({ triggers: [{ kind: 'event', event: 'ghost:vanished' }] }),
        ]);
        const trigger = s?.triggers[0];
        expect(trigger?.kind === 'event' && trigger.known).toBe(false);
        // Enabled, armed-looking, and incapable of ever running. The whole
        // reason the manager is worth opening.
        expect(s?.enabled).toBe(true);
        expect(s?.canEverFire).toBe(false);
    });

    it('a Flow with one live trigger among dead ones CAN still fire', () => {
        const [s] = summarise([
            flow({
                triggers: [
                    { kind: 'event', event: 'ghost:vanished' },
                    { kind: 'event', event: 'demo:happened' },
                ],
            }),
        ]);
        // POSITIVE CONTROL for the assertion above: `canEverFire` tracks whether
        // ANY trigger is live, so it is not simply false whenever an unknown
        // event appears anywhere.
        expect(s?.canEverFire).toBe(true);
    });

    it('a disabled Flow cannot fire, however good its triggers are', () => {
        const [s] = summarise([
            flow({ enabled: false, triggers: [{ kind: 'event', event: 'demo:happened' }] }),
        ]);
        expect(s?.canEverFire).toBe(false);
    });

    it('a disabled Flow is not manually runnable either', () => {
        const [s] = summarise([flow({ enabled: false, triggers: [{ kind: 'manual' }] })]);
        expect(s?.manuallyRunnable).toBe(false);
    });
});

describe('live state and history', () => {
    it('marks the Flows that are running right now', () => {
        const [a, b] = summarise([flow({ id: 'f1' }), flow({ id: 'f2' })], {
            runningFlowIds: ['f2'],
        });
        // Both asserted: a summariser that hardcoded either answer passes half
        // of this and fails the other.
        expect(a?.running).toBe(false);
        expect(b?.running).toBe(true);
    });

    it('carries the last run, outcome and all', () => {
        const [s] = summarise([flow({ id: 'f1' })], {
            lastRuns: new Map([['f1', run({ outcome: 'failed', reason: 'EACCES' })]]),
        });
        expect(s?.lastRun?.outcome).toBe('failed');
        expect(s?.lastRun?.reason).toBe('EACCES');
    });

    it('leaves lastRun absent for a Flow that has never run', () => {
        const [s] = summarise([flow({ id: 'f1' })], { lastRuns: new Map() });
        expect(s?.lastRun).toBeUndefined();
    });
});

describe('ordering', () => {
    it('groups by purpose then title, the order the store already reads in', () => {
        const summaries = summarise([
            flow({ id: 'c', purpose: 'Zed', title: 'A' }),
            flow({ id: 'b', purpose: 'Alpha', title: 'Z' }),
            flow({ id: 'a', purpose: 'Alpha', title: 'A' }),
        ]);
        expect(summaries.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    });
});
