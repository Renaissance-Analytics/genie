/**
 * ★ THE HEADLINE TEST — a new system event kind is DATA, not a code path.
 *
 * The owner's constraint for #270, verbatim:
 *
 *   > this list will need to be able to expand without a huge system overhaul.
 *
 * A comment claiming that would prove nothing, so this file proves it twice:
 *
 *  1. BEHAVIOURALLY — an event kind that exists nowhere in Genie's source is
 *     registered from a test, a Wish filters on ITS props, and the Wish runs.
 *     Nothing in `main/wishes/` is edited to make that happen.
 *  2. STRUCTURALLY — the matching/filtering/dispatch modules are asserted to
 *     contain NO event id at all. That is the invariant that keeps property (1)
 *     true: the day somebody adds `if (event === 'files:added')` to the engine,
 *     this test fails and says why.
 *
 * Both directions are controlled: a filter that excludes is paired with one that
 * includes, because "the Wish did not fire" passes just as well against a Wish
 * that never fires at all.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BUILT_IN_WISH_EVENTS, createWishEventRegistry } from '../events';
import { WishLoopGuard } from '../loop';
import { WishRuntime } from '../runtime';
import type { Wish, WishRecipe } from '../types';

/** An event kind Genie has never heard of, declared entirely here. */
const DEMO_EVENT = {
    id: 'demo:pinged',
    label: 'A demo ping arrived',
    purpose: 'Testing',
    props: [
        { key: 'level', type: 'number', label: 'Ping level' },
        { key: 'room', type: 'string', label: 'Room' },
    ],
} as const;

function harness() {
    const registry = createWishEventRegistry();
    registry.register(DEMO_EVENT);

    const ran: number[] = [];
    const recipe: WishRecipe = {
        id: 'demo.record',
        title: 'Record the ping',
        steps: [
            {
                type: 'task',
                id: 'record',
                title: 'Record',
                run: async (ctx) => {
                    ran.push(Number(ctx.get('level')));
                },
            },
        ],
    };

    const wish: Wish = {
        id: 'wish-demo',
        title: 'Record loud pings',
        purpose: 'Testing',
        scope: { kind: 'workstation' },
        enabled: true,
        triggers: [
            {
                kind: 'event',
                event: 'demo:pinged',
                filter: { all: [{ prop: 'level', op: 'gte', value: 5 }] },
            },
        ],
        recipe: { kind: 'builtin', recipeId: 'demo.record' },
    };

    const runtime = new WishRuntime({
        registry,
        guard: new WishLoopGuard(),
        listWishes: () => [wish],
        resolveRecipe: (ref) => (ref.recipeId === 'demo.record' ? recipe : null),
    });

    return { runtime, ran };
}

describe('a new system event kind is added as DATA', () => {
    it('fires a Wish that filters on props the new event declares', async () => {
        const { runtime, ran } = harness();

        const logs = await runtime.emit({
            event: 'demo:pinged',
            props: { level: 7, room: 'library' },
            source: { kind: 'system' },
        });

        expect(ran).toEqual([7]);
        expect(logs.map((l) => l.outcome)).toEqual(['ran']);
    });

    it('does NOT fire when the filter excludes — and the same Wish fires at the boundary', async () => {
        // Negative control.
        const excluded = harness();
        await excluded.runtime.emit({
            event: 'demo:pinged',
            props: { level: 2, room: 'library' },
            source: { kind: 'system' },
        });
        expect(excluded.ran).toEqual([]);

        // POSITIVE control for that negative: the identical Wish, one prop value
        // different, DOES fire. Without this, a Wish that could never run would
        // pass the assertion above.
        const included = harness();
        await included.runtime.emit({
            event: 'demo:pinged',
            props: { level: 5, room: 'library' },
            source: { kind: 'system' },
        });
        expect(included.ran).toEqual([5]);
    });

    it('refuses a trigger naming an event nobody registered, and says so', async () => {
        const registry = createWishEventRegistry();
        const wish: Wish = {
            id: 'wish-ghost',
            title: 'React to nothing',
            purpose: 'Testing',
            scope: { kind: 'workstation' },
            enabled: true,
            triggers: [{ kind: 'event', event: 'demo:pinged' }],
            recipe: { kind: 'builtin', recipeId: 'demo.record' },
        };
        const runtime = new WishRuntime({
            registry,
            guard: new WishLoopGuard(),
            listWishes: () => [wish],
            resolveRecipe: () => null,
        });

        const logs = await runtime.emit({
            event: 'demo:pinged',
            props: { level: 9 },
            source: { kind: 'system' },
        });
        expect(logs).toEqual([]);
    });
});

/**
 * The structural half. `ENGINE_MODULES` decide WHICH Wish runs and WHETHER it
 * may — they must be able to say that about an event kind they have never been
 * told about, so they may not name one.
 */
const ENGINE_MODULES = ['runtime.ts', 'match.ts', 'filter.ts', 'loop.ts', 'admission.ts', 'recipe.ts'];

/** A module that legitimately DOES name the event — the positive control. */
const EVENT_SOURCE_MODULE = 'file-source.ts';

function readModule(name: string): string {
    return fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
}

describe('the engine names no event kind', () => {
    it('has at least one built-in event id to look for', () => {
        expect(BUILT_IN_WISH_EVENTS.length).toBeGreaterThan(0);
    });

    it('finds every built-in event id in the module that PRODUCES it (control)', () => {
        // Proves the check below can detect a mention at all. Without this, an
        // absent-string assertion would pass against a typo in the search term.
        const source = readModule(EVENT_SOURCE_MODULE);
        for (const def of BUILT_IN_WISH_EVENTS) {
            expect(source).toContain(def.id);
        }
    });

    it('finds NO event id anywhere in the modules that dispatch, match or judge', () => {
        for (const moduleName of ENGINE_MODULES) {
            const source = readModule(moduleName);
            for (const def of BUILT_IN_WISH_EVENTS) {
                expect(
                    source.includes(def.id),
                    `${moduleName} names the event "${def.id}". The engine must decide about ` +
                        `event kinds it has never heard of — move this into a registry entry.`,
                ).toBe(false);
            }
        }
    });
});
