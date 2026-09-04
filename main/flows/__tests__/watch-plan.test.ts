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
import type { Flow } from '../types';

const registry = createFlowEventRegistry();
registry.register({ id: 'demo:pinged', label: 'Ping', props: [] });

const WORKSPACES = [
    { id: 'ws-1', path: '/p/one' },
    { id: 'ws-2', path: '/p/two' },
];

function flow(over: Partial<Flow> = {}): Flow {
    return {
        id: 'w',
        title: 'W',
        purpose: 'Files',
        scope: { kind: 'system' },
        enabled: true,
        triggers: [{ kind: 'event', event: 'files:added' }],
        recipe: { kind: 'builtin', recipeId: 'r' },
        ...over,
    };
}

const plan = (flows: Flow[]) => planFlowFileWatches(flows, WORKSPACES, registry);

describe('planFlowFileWatches', () => {
    it('watches nothing when no Flow asks for a file event', () => {
        expect(plan([])).toEqual([]);
        expect(plan([flow({ triggers: [{ kind: 'manual' }] })])).toEqual([]);
        expect(plan([flow({ triggers: [{ kind: 'event', event: 'demo:pinged' }] })])).toEqual([]);
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
