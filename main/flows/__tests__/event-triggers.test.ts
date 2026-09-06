import { describe, expect, it } from 'vitest';
import { getNodeKind } from '@particle-academy/fancy-flow/engine';
import { GENIE_EVENT_TRIGGER_KIND, registerEventTriggerKind } from '../event-trigger';
import { declaredTriggers, eventTriggersFor } from '../triggers';
import { selectFlowsForEvent } from '../select';
import { createFlowEventRegistry } from '../events';
import { FILE_ADDED_EVENT } from '../file-source';
import type { FlowEvent } from '../types';
import type { FlowRow } from '../store';

/**
 * What starts a flow, and which branch of it runs.
 *
 * fancy-flow's trigger nodes DECLARE a trigger; nothing in the package observes
 * a host. So the half Genie keeps from the system it replaced is the half fancy
 * does not have — an event registry, producers that emit, and the selection
 * that decides which flows an event reaches. The half it drops is the bespoke
 * filter language: a condition is a `branch` node now, on the canvas, where the
 * author can see it.
 *
 * ## `entryNodes` is not optional
 *
 * A graph may hold a manual trigger for hand-testing beside the event trigger
 * that runs it for real. A trigger has no inbound edges, which IS the engine's
 * readiness rule — so unless the run names which entry points are live, EVERY
 * trigger's branch runs on every fire. Selection therefore returns the node that
 * matched, not just the flow.
 *
 * ## Adding an event kind must stay "add an entry to a list"
 *
 * The owner's constraint for #270. Nothing here names an event id, and the
 * options a trigger node offers come from the live registry — so a second
 * producer is a registry entry and no engine change.
 */

const registry = () => createFlowEventRegistry([FILE_ADDED_EVENT]);

const eventTriggerNode = (id: string, event: string) => ({
    id,
    type: GENIE_EVENT_TRIGGER_KIND,
    position: { x: 0, y: 0 },
    data: { kind: GENIE_EVENT_TRIGGER_KIND, label: 'When', config: { event } },
});

const manualNode = (id: string) => ({
    id,
    type: '@particle-academy/manual_trigger',
    position: { x: 0, y: 0 },
    data: { kind: '@particle-academy/manual_trigger', label: 'Start', config: {} },
});

function flow(over: Partial<FlowRow> & Pick<FlowRow, 'id' | 'scope' | 'graph'>): FlowRow {
    return {
        title: over.id,
        purpose: 'Automation',
        appId: null,
        enabled: true,
        createdAt: 'x',
        updatedAt: 'x',
        ...over,
    } as FlowRow;
}

const fileEvent = (props: Record<string, string | number | boolean>): FlowEvent => ({
    event: 'files:added',
    props,
    source: { kind: 'system' },
});

describe('the event trigger node', () => {
    it('registers, so the canvas can offer it', () => {
        registerEventTriggerKind(registry());

        expect(getNodeKind(GENIE_EVENT_TRIGGER_KIND)?.category).toBe('trigger');
    });

    it('offers exactly the events the registry knows, not a hard-coded list', () => {
        // #270's constraint: adding an event kind must be adding an entry.
        registerEventTriggerKind(registry());
        const field = getNodeKind(GENIE_EVENT_TRIGGER_KIND)?.configSchema?.find(
            (f) => f.key === 'event',
        );

        expect((field as { options?: { value: string }[] })?.options?.map((o) => o.value)).toEqual([
            'files:added',
        ]);
    });
});

describe('reading triggers off a graph', () => {
    it('sees an event trigger beside the built-in kinds', () => {
        const graph = { nodes: [manualNode('m'), eventTriggerNode('e', 'files:added')], edges: [] };

        expect(declaredTriggers(graph).map((t) => ({ id: t.nodeId, kind: t.kind }))).toEqual([
            { id: 'm', kind: 'manual' },
            { id: 'e', kind: 'event' },
        ]);
    });

    it('names the event each trigger listens for', () => {
        const graph = { nodes: [eventTriggerNode('e', 'files:added')], edges: [] };

        expect(eventTriggersFor(graph, 'files:added').map((t) => t.nodeId)).toEqual(['e']);
        expect(eventTriggersFor(graph, 'agents:finished')).toEqual([]);
    });

    it('ignores an event trigger with no event chosen, rather than matching everything', () => {
        // A half-finished node must not become a wildcard. That would be an
        // automation firing on things nobody selected.
        const graph = { nodes: [eventTriggerNode('e', '')], edges: [] };

        expect(eventTriggersFor(graph, 'files:added')).toEqual([]);
    });
});

describe('which flows an event reaches', () => {
    const graph = { nodes: [eventTriggerNode('e', 'files:added')], edges: [] };

    it('runs a system flow listening for it', () => {
        const chosen = selectFlowsForEvent(
            [flow({ id: 'f', scope: { kind: 'system' }, graph })],
            fileEvent({ workspaceId: 'ws-1' }),
        );

        expect(chosen).toEqual([{ flowId: 'f', nodeIds: ['e'] }]);
    });

    it('runs a workspace flow only for its OWN workspace', () => {
        const flows = [flow({ id: 'f', scope: { kind: 'workspace', workspaceId: 'ws-7' }, graph })];

        expect(selectFlowsForEvent(flows, fileEvent({ workspaceId: 'ws-7' }))).toHaveLength(1);
        expect(selectFlowsForEvent(flows, fileEvent({ workspaceId: 'ws-OTHER' }))).toHaveLength(0);
    });

    it('does NOT run a workspace flow on an event that names no workspace', () => {
        // The promise of the middle rung is that the flow cannot act on another
        // project. An event with no workspace could be about anything, so it is
        // not this flow's.
        const flows = [flow({ id: 'f', scope: { kind: 'workspace', workspaceId: 'ws-7' }, graph })];

        expect(selectFlowsForEvent(flows, fileEvent({}))).toHaveLength(0);
    });

    it('skips a disabled flow', () => {
        expect(
            selectFlowsForEvent(
                [flow({ id: 'f', scope: { kind: 'system' }, graph, enabled: false })],
                fileEvent({}),
            ),
        ).toHaveLength(0);
    });

    it('skips a flow whose scope will not parse', () => {
        expect(
            selectFlowsForEvent(
                [flow({ id: 'f', scope: null, graph })],
                fileEvent({}),
            ),
        ).toHaveLength(0);
    });

    it('skips a flow with a corrupt graph rather than throwing', () => {
        expect(() =>
            selectFlowsForEvent([flow({ id: 'f', scope: { kind: 'system' }, graph: null })], fileEvent({})),
        ).not.toThrow();
    });

    it('names ONLY the trigger nodes that matched', () => {
        // The whole reason selection returns nodes. A manual trigger sitting
        // beside the event one must stay inactive, or its branch runs too.
        const mixed = {
            nodes: [manualNode('m'), eventTriggerNode('e', 'files:added')],
            edges: [],
        };

        expect(
            selectFlowsForEvent([flow({ id: 'f', scope: { kind: 'system' }, graph: mixed })], fileEvent({})),
        ).toEqual([{ flowId: 'f', nodeIds: ['e'] }]);
    });

    it('names both when a graph listens for the same event twice', () => {
        const twice = {
            nodes: [eventTriggerNode('a', 'files:added'), eventTriggerNode('b', 'files:added')],
            edges: [],
        };

        expect(
            selectFlowsForEvent([flow({ id: 'f', scope: { kind: 'system' }, graph: twice })], fileEvent({})),
        ).toEqual([{ flowId: 'f', nodeIds: ['a', 'b'] }]);
    });

    it('names no event id anywhere in the selection', () => {
        // The extensibility property, asserted structurally rather than trusted:
        // a registry entry for an event Genie has never heard of must select.
        const unheard = {
            nodes: [eventTriggerNode('e', 'weather:changed')],
            edges: [],
        };

        expect(
            selectFlowsForEvent([flow({ id: 'f', scope: { kind: 'system' }, graph: unheard })], {
                event: 'weather:changed',
                props: {},
                source: { kind: 'system' },
            }),
        ).toEqual([{ flowId: 'f', nodeIds: ['e'] }]);
    });
});
