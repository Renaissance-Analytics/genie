/**
 * Which workspaces Genie actually watches for Wishes.
 *
 * A recursive `fs.watch` over a workspace is not free — it holds OS handles and
 * fires on every build, install and checkout. Watching every workspace on the
 * machine because SOMEBODY might one day write a file Wish would be a permanent
 * cost for a feature nobody is using, so the watch set is derived from what the
 * Wishes actually declare.
 *
 * The failure this must not have is the opposite one: a workspace that should be
 * watched and is not, which shows up as a Wish that silently never fires. So the
 * plan is a pure function with the boring case (nothing declared, watch nothing)
 * asserted alongside every case that widens it.
 */

import { describe, expect, it } from 'vitest';
import { createWishEventRegistry } from '../events';
import { planWishFileWatches } from '../watch-plan';
import type { Wish } from '../types';

const registry = createWishEventRegistry();
registry.register({ id: 'demo:pinged', label: 'Ping', props: [] });

const WORKSPACES = [
    { id: 'ws-1', path: '/p/one' },
    { id: 'ws-2', path: '/p/two' },
];

function wish(over: Partial<Wish> = {}): Wish {
    return {
        id: 'w',
        title: 'W',
        purpose: 'Files',
        scope: { kind: 'workstation' },
        enabled: true,
        triggers: [{ kind: 'event', event: 'files:added' }],
        recipe: { kind: 'builtin', recipeId: 'r' },
        ...over,
    };
}

const plan = (wishes: Wish[]) => planWishFileWatches(wishes, WORKSPACES, registry);

describe('planWishFileWatches', () => {
    it('watches nothing when no Wish asks for a file event', () => {
        expect(plan([])).toEqual([]);
        expect(plan([wish({ triggers: [{ kind: 'manual' }] })])).toEqual([]);
        expect(plan([wish({ triggers: [{ kind: 'event', event: 'demo:pinged' }] })])).toEqual([]);
    });

    it('watches every workspace for a workstation-scoped file Wish', () => {
        expect(plan([wish()]).map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
    });

    it('watches only its own workspace for a workspace-scoped Wish', () => {
        expect(
            plan([wish({ scope: { kind: 'workspace', workspaceId: 'ws-2' } })]).map((w) => w.id),
        ).toEqual(['ws-2']);
    });

    it('ignores a disabled Wish', () => {
        expect(plan([wish({ enabled: false })])).toEqual([]);
        // POSITIVE CONTROL: enabling the identical Wish does widen the plan, so
        // the assertion above is about `enabled` and not about a dead planner.
        expect(plan([wish({ enabled: true })])).toHaveLength(2);
    });

    it('names a workspace once even when several Wishes want it', () => {
        expect(
            plan([
                wish({ id: 'a', scope: { kind: 'workspace', workspaceId: 'ws-1' } }),
                wish({ id: 'b', scope: { kind: 'workspace', workspaceId: 'ws-1' } }),
                wish({ id: 'c' }),
            ]).map((w) => w.id),
        ).toEqual(['ws-1', 'ws-2']);
    });

    it('drops a workspace-scoped Wish pointing at a workspace that is gone', () => {
        expect(plan([wish({ scope: { kind: 'workspace', workspaceId: 'ws-removed' } })])).toEqual(
            [],
        );
    });
});
