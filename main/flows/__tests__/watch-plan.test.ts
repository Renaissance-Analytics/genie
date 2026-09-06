/**
 * Which workspaces Genie actually watches for Flows.
 *
 * A recursive `fs.watch` over a workspace is not free — it holds OS handles and
 * fires on every build, install and checkout. Watching every workspace on the
 * machine because SOMEBODY might one day write a file Flow would be a permanent
 * cost for a feature nobody is using, so the watch set is derived from what the
 * Flows actually declare.
 *
 * The failure this must not have is the opposite one: a workspace that should be
 * watched and is not, which shows up as a Flow that silently never fires. So the
 * plan is a pure function with the boring case (nothing declared, watch nothing)
 * asserted alongside every case that widens it.
 */

import { describe, expect, it } from 'vitest';
import { createFlowEventRegistry } from '../events';
import { planFlowFileWatches } from '../watch-plan';
import { GENIE_EVENT_TRIGGER_KIND } from '../event-trigger';
import type { FlowRow } from '../store';

/**
 * Triggers come off the GRAPH now, not from a list beside it.
 *
 * That is the whole shape of the change: a flow IS a fancy-flow graph, and the
 * trigger nodes in it are the answer to "what starts this". A second stored
 * trigger list was one of the two answers the old split maintained.
 */
const eventTrigger = (event: string) => ({
    id: `t-${event}`,
    type: GENIE_EVENT_TRIGGER_KIND,
    position: { x: 0, y: 0 },
    data: { kind: GENIE_EVENT_TRIGGER_KIND, label: 'When', config: { event } },
});

const manualTrigger = () => ({
    id: 't-manual',
    type: '@particle-academy/manual_trigger',
    position: { x: 0, y: 0 },
    data: { kind: '@particle-academy/manual_trigger', label: 'Start', config: {} },
});

const graphOf = (...nodes: unknown[]) => ({ nodes, edges: [] });

const registry = createFlowEventRegistry();
registry.register({ id: 'demo:pinged', label: 'Ping', props: [] });

const WORKSPACES = [
    { id: 'ws-1', path: '/p/one' },
    { id: 'ws-2', path: '/p/two' },
];

function flow(over: Partial<FlowRow> = {}): FlowRow {
    return {
        id: 'w',
        appId: null,
        title: 'W',
        purpose: 'Files',
        scope: { kind: 'system' },
        enabled: true,
        graph: graphOf(eventTrigger('files:added')) as never,
        createdAt: 'x',
        updatedAt: 'x',
        ...over,
    };
}

const plan = (flows: FlowRow[]) => planFlowFileWatches(flows, WORKSPACES, registry);

describe('planFlowFileWatches', () => {
    it('watches nothing when no Flow asks for a file event', () => {
        expect(plan([])).toEqual([]);
        expect(plan([flow({ graph: graphOf(manualTrigger()) as never })])).toEqual([]);
        expect(plan([flow({ graph: graphOf(eventTrigger('demo:pinged')) as never })])).toEqual([]);
    });

    it('watches every workspace for a system-scoped file Flow', () => {
        expect(plan([flow()]).map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
    });

    it('watches only its own workspace for a workspace-scoped Flow', () => {
        expect(
            plan([flow({ scope: { kind: 'workspace', workspaceId: 'ws-2' } })]).map((w) => w.id),
        ).toEqual(['ws-2']);
    });

    it('ignores a disabled Flow', () => {
        expect(plan([flow({ enabled: false })])).toEqual([]);
        // POSITIVE CONTROL: enabling the identical Flow does widen the plan, so
        // the assertion above is about `enabled` and not about a dead planner.
        expect(plan([flow({ enabled: true })])).toHaveLength(2);
    });

    it('names a workspace once even when several Flows want it', () => {
        expect(
            plan([
                flow({ id: 'a', scope: { kind: 'workspace', workspaceId: 'ws-1' } }),
                flow({ id: 'b', scope: { kind: 'workspace', workspaceId: 'ws-1' } }),
                flow({ id: 'c' }),
            ]).map((w) => w.id),
        ).toEqual(['ws-1', 'ws-2']);
    });

    it('drops a workspace-scoped Flow pointing at a workspace that is gone', () => {
        expect(plan([flow({ scope: { kind: 'workspace', workspaceId: 'ws-removed' } })])).toEqual(
            [],
        );
    });
});
