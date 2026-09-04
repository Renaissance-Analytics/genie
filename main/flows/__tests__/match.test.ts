/**
 * Scope: which Flows an event may reach, and who may see one.
 *
 * These are authorisation rules, which is why they live in the model rather than
 * in whichever menu happens to be drawing itself. Two of them have teeth:
 *
 *  - a workspace-scoped Flow must never act on another project's files;
 *  - a GApp-scoped Flow must appear in no menu outside that GApp.
 *
 * Both are asserted with the permitted case beside the refused one, so a rule
 * that denied everything could not pass.
 */

import { describe, expect, it } from 'vitest';
import { createFlowEventRegistry } from '../events';
import { eventInScope, isManuallyRunnable, isFlowVisibleTo, selectFlowsForEvent } from '../match';
import type { Flow, FlowEvent } from '../types';

const registry = createFlowEventRegistry();
registry.register({
    id: 'demo:happened',
    label: 'Demo',
    props: [
        { key: 'workspaceId', type: 'string', label: 'Workspace' },
        { key: 'size', type: 'number', label: 'Size' },
    ],
});

function flow(over: Partial<Flow> = {}): Flow {
    return {
        id: 'w',
        title: 'W',
        purpose: 'Testing',
        scope: { kind: 'system' },
        enabled: true,
        triggers: [{ kind: 'event', event: 'demo:happened' }],
        recipe: { kind: 'builtin', recipeId: 'r' },
        ...over,
    };
}

function event(props: Record<string, string | number> = {}): FlowEvent {
    return { event: 'demo:happened', props, source: { kind: 'system' } };
}

describe('a workspace-scoped Flow only sees its own workspace', () => {
    it('is in scope for its own workspace and out of scope for another', () => {
        const w = flow({ scope: { kind: 'workspace', workspaceId: 'ws-1' } });
        expect(eventInScope(w, event({ workspaceId: 'ws-1' }))).toBe(true);
        expect(eventInScope(w, event({ workspaceId: 'ws-2' }))).toBe(false);
    });

    it('is out of scope for an event that names no workspace — fail closed', () => {
        // "Cannot be shown to be in scope" is not "in scope". The alternative is
        // a Flow scoped to one project acting on something it cannot place.
        const w = flow({ scope: { kind: 'workspace', workspaceId: 'ws-1' } });
        expect(eventInScope(w, event({}))).toBe(false);
    });

    it('lets a system Flow see everything, including workspace-less events', () => {
        const w = flow({ scope: { kind: 'system' } });
        expect(eventInScope(w, event({}))).toBe(true);
        expect(eventInScope(w, event({ workspaceId: 'ws-9' }))).toBe(true);
    });
});

describe('selectFlowsForEvent', () => {
    it('selects the enabled, in-scope, matching Flows and nothing else', () => {
        const flows = [
            flow({ id: 'match' }),
            flow({ id: 'disabled', enabled: false }),
            flow({ id: 'other-event', triggers: [{ kind: 'event', event: 'demo:other' }] }),
            flow({ id: 'manual-only', triggers: [{ kind: 'manual' }] }),
            flow({
                id: 'wrong-workspace',
                scope: { kind: 'workspace', workspaceId: 'ws-2' },
            }),
            flow({
                id: 'filtered-out',
                triggers: [
                    {
                        kind: 'event',
                        event: 'demo:happened',
                        filter: { all: [{ prop: 'size', op: 'gt', value: 100 }] },
                    },
                ],
            }),
        ];

        const { matches } = selectFlowsForEvent(
            flows,
            event({ workspaceId: 'ws-1', size: 10 }),
            registry,
        );
        expect(matches.map((m) => m.flow.id)).toEqual(['match']);
    });

    it('runs a Flow once even when two of its triggers name the same event', () => {
        const w = flow({
            triggers: [
                {
                    kind: 'event',
                    event: 'demo:happened',
                    filter: { all: [{ prop: 'size', op: 'gt', value: 1 }] },
                },
                {
                    kind: 'event',
                    event: 'demo:happened',
                    filter: { all: [{ prop: 'size', op: 'lt', value: 100 }] },
                },
            ],
        });
        const { matches } = selectFlowsForEvent([w], event({ size: 10 }), registry);
        expect(matches).toHaveLength(1);
    });

    it('ignores an event kind nothing registered', () => {
        const { matches, problems } = selectFlowsForEvent(
            [flow({ triggers: [{ kind: 'event', event: 'ghost:seen' }] })],
            { event: 'ghost:seen', props: {}, source: { kind: 'system' } },
            registry,
        );
        expect(matches).toEqual([]);
        expect(problems).toEqual([]);
    });

    it('reports a Flow whose filter cannot be evaluated instead of dropping it', () => {
        const broken = flow({
            id: 'broken',
            triggers: [
                {
                    kind: 'event',
                    event: 'demo:happened',
                    filter: { all: [{ prop: 'size', op: 'gt', value: 'huge' as never }] },
                },
            ],
        });
        const { matches, problems } = selectFlowsForEvent([broken], event({ size: 5 }), registry);
        expect(matches).toEqual([]);
        expect(problems).toHaveLength(1);
        expect(problems[0].flowId).toBe('broken');
        expect(problems[0].reason).toContain('number');
    });
});

/**
 * `gapp` scope IS internal (genie#394).
 *
 * The scope used to carry a second field, `exposure`, deciding whether a GApp's
 * Flow appeared outside that GApp. It is gone: the scope ladder is
 * system / workspace / gapp, and a `gapp` scope means the Flow belongs to that
 * GApp and appears nowhere else. A GApp Flow meant to be visible machine-wide
 * is a `system` Flow — the visibility is the scope, not a flag on top of one.
 */
describe('a GApp Flow appears in no menu outside its GApp', () => {
    const owned = flow({ scope: { kind: 'gapp', appId: 'trader' } });

    it('is hidden from the system and from other apps', () => {
        expect(isFlowVisibleTo(owned, { kind: 'system' })).toBe(false);
        expect(isFlowVisibleTo(owned, { kind: 'gapp', appId: 'other' })).toBe(false);
    });

    it('is visible to the GApp that owns it', () => {
        // POSITIVE CONTROL for the two refusals above.
        expect(isFlowVisibleTo(owned, { kind: 'gapp', appId: 'trader' })).toBe(true);
    });

    it('shows a system Flow to a GApp as well as to the system', () => {
        // What `exposure: 'workstation'` used to buy, said as a scope. A GApp
        // asking for its menu sees the machine's Flows too.
        const everywhere = flow({ scope: { kind: 'system' } });
        expect(isFlowVisibleTo(everywhere, { kind: 'system' })).toBe(true);
        expect(isFlowVisibleTo(everywhere, { kind: 'gapp', appId: 'other' })).toBe(true);
    });

    it('does not hide Flows that belong to no app', () => {
        expect(isFlowVisibleTo(flow(), { kind: 'system' })).toBe(true);
        expect(
            isFlowVisibleTo(flow({ scope: { kind: 'workspace', workspaceId: 'ws-1' } }), {
                kind: 'system',
            }),
        ).toBe(true);
    });
});

describe('isManuallyRunnable', () => {
    it('is true only for an enabled Flow with a manual trigger', () => {
        expect(isManuallyRunnable(flow({ triggers: [{ kind: 'manual' }] }))).toBe(true);
        expect(
            isManuallyRunnable(flow({ triggers: [{ kind: 'manual' }], enabled: false })),
        ).toBe(false);
        expect(isManuallyRunnable(flow())).toBe(false);
    });
});
