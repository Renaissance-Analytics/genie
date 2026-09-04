/**
 * Scope: which Wishes an event may reach, and who may see one.
 *
 * These are authorisation rules, which is why they live in the model rather than
 * in whichever menu happens to be drawing itself. Two of them have teeth:
 *
 *  - a workspace-scoped Wish must never act on another project's files;
 *  - a GApp's INTERNAL Wish must appear in no menu outside that GApp.
 *
 * Both are asserted with the permitted case beside the refused one, so a rule
 * that denied everything could not pass.
 */

import { describe, expect, it } from 'vitest';
import { createWishEventRegistry } from '../events';
import { eventInScope, isManuallyRunnable, isWishVisibleTo, selectWishesForEvent } from '../match';
import type { Wish, WishEvent } from '../types';

const registry = createWishEventRegistry();
registry.register({
    id: 'demo:happened',
    label: 'Demo',
    props: [
        { key: 'workspaceId', type: 'string', label: 'Workspace' },
        { key: 'size', type: 'number', label: 'Size' },
    ],
});

function wish(over: Partial<Wish> = {}): Wish {
    return {
        id: 'w',
        title: 'W',
        purpose: 'Testing',
        scope: { kind: 'workstation' },
        enabled: true,
        triggers: [{ kind: 'event', event: 'demo:happened' }],
        recipe: { kind: 'builtin', recipeId: 'r' },
        ...over,
    };
}

function event(props: Record<string, string | number> = {}): WishEvent {
    return { event: 'demo:happened', props, source: { kind: 'system' } };
}

describe('a workspace-scoped Wish only sees its own workspace', () => {
    it('is in scope for its own workspace and out of scope for another', () => {
        const w = wish({ scope: { kind: 'workspace', workspaceId: 'ws-1' } });
        expect(eventInScope(w, event({ workspaceId: 'ws-1' }))).toBe(true);
        expect(eventInScope(w, event({ workspaceId: 'ws-2' }))).toBe(false);
    });

    it('is out of scope for an event that names no workspace — fail closed', () => {
        // "Cannot be shown to be in scope" is not "in scope". The alternative is
        // a Wish scoped to one project acting on something it cannot place.
        const w = wish({ scope: { kind: 'workspace', workspaceId: 'ws-1' } });
        expect(eventInScope(w, event({}))).toBe(false);
    });

    it('lets a workstation Wish see everything, including workspace-less events', () => {
        const w = wish({ scope: { kind: 'workstation' } });
        expect(eventInScope(w, event({}))).toBe(true);
        expect(eventInScope(w, event({ workspaceId: 'ws-9' }))).toBe(true);
    });
});

describe('selectWishesForEvent', () => {
    it('selects the enabled, in-scope, matching Wishes and nothing else', () => {
        const wishes = [
            wish({ id: 'match' }),
            wish({ id: 'disabled', enabled: false }),
            wish({ id: 'other-event', triggers: [{ kind: 'event', event: 'demo:other' }] }),
            wish({ id: 'manual-only', triggers: [{ kind: 'manual' }] }),
            wish({
                id: 'wrong-workspace',
                scope: { kind: 'workspace', workspaceId: 'ws-2' },
            }),
            wish({
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

        const { matches } = selectWishesForEvent(
            wishes,
            event({ workspaceId: 'ws-1', size: 10 }),
            registry,
        );
        expect(matches.map((m) => m.wish.id)).toEqual(['match']);
    });

    it('runs a Wish once even when two of its triggers name the same event', () => {
        const w = wish({
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
        const { matches } = selectWishesForEvent([w], event({ size: 10 }), registry);
        expect(matches).toHaveLength(1);
    });

    it('ignores an event kind nothing registered', () => {
        const { matches, problems } = selectWishesForEvent(
            [wish({ triggers: [{ kind: 'event', event: 'ghost:seen' }] })],
            { event: 'ghost:seen', props: {}, source: { kind: 'system' } },
            registry,
        );
        expect(matches).toEqual([]);
        expect(problems).toEqual([]);
    });

    it('reports a Wish whose filter cannot be evaluated instead of dropping it', () => {
        const broken = wish({
            id: 'broken',
            triggers: [
                {
                    kind: 'event',
                    event: 'demo:happened',
                    filter: { all: [{ prop: 'size', op: 'gt', value: 'huge' as never }] },
                },
            ],
        });
        const { matches, problems } = selectWishesForEvent([broken], event({ size: 5 }), registry);
        expect(matches).toEqual([]);
        expect(problems).toHaveLength(1);
        expect(problems[0].wishId).toBe('broken');
        expect(problems[0].reason).toContain('number');
    });
});

describe('a GApp’s internal Wish appears in no menu outside its GApp', () => {
    const internal = wish({
        scope: { kind: 'app', appId: 'trader', exposure: 'internal' },
    });
    const exposed = wish({
        scope: { kind: 'app', appId: 'trader', exposure: 'workstation' },
    });

    it('is hidden from the workstation and from other apps', () => {
        expect(isWishVisibleTo(internal, { kind: 'workstation' })).toBe(false);
        expect(isWishVisibleTo(internal, { kind: 'app', appId: 'other' })).toBe(false);
    });

    it('is visible to the GApp that owns it', () => {
        // POSITIVE CONTROL for the two refusals above.
        expect(isWishVisibleTo(internal, { kind: 'app', appId: 'trader' })).toBe(true);
    });

    it('does not hide a Wish the GApp exposed to the workstation', () => {
        expect(isWishVisibleTo(exposed, { kind: 'workstation' })).toBe(true);
        expect(isWishVisibleTo(exposed, { kind: 'app', appId: 'other' })).toBe(true);
    });

    it('does not hide Wishes that belong to no app', () => {
        expect(isWishVisibleTo(wish(), { kind: 'workstation' })).toBe(true);
        expect(
            isWishVisibleTo(wish({ scope: { kind: 'workspace', workspaceId: 'ws-1' } }), {
                kind: 'workstation',
            }),
        ).toBe(true);
    });
});

describe('isManuallyRunnable', () => {
    it('is true only for an enabled Wish with a manual trigger', () => {
        expect(isManuallyRunnable(wish({ triggers: [{ kind: 'manual' }] }))).toBe(true);
        expect(
            isManuallyRunnable(wish({ triggers: [{ kind: 'manual' }], enabled: false })),
        ).toBe(false);
        expect(isManuallyRunnable(wish())).toBe(false);
    });
});
