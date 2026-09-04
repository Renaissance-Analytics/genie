/**
 * The trigger registry — a curated, named set of event kinds, held as DATA.
 *
 * ## Why a registry rather than a switch
 *
 * The owner's constraint for #270 is the one that shapes this whole file:
 *
 *   > this list will need to be able to expand without a huge system overhaul.
 *
 * A trigger system that needs an engine change to learn a new event ossifies,
 * and the feature calcifies with it. So the only thing adding an event kind may
 * require is adding an entry — and `__tests__/extensible-events.test.ts` holds
 * that property down from both ends: it registers an event Genie has never
 * heard of and runs a Wish off it, and it asserts that the modules which match,
 * filter and dispatch name NO event id at all.
 *
 * `main/remote/index.ts` already maintains `PASSTHROUGH_EVENTS` — a reviewed,
 * named set of events deemed safe to forward over a remote link. This is the
 * same idea with the one addition a filter needs: each entry also declares the
 * PROPS it emits, so a Wish's predicate can be checked against something real
 * when it is written instead of failing silently at 3am.
 *
 * ## The registry is an object, not a module global
 *
 * A module-level singleton would make every test share one mutable list, and a
 * test that registered an event would leak it into whichever ran next. The
 * registry is constructed; production makes exactly one (`index.ts`) and hands
 * it to the runtime.
 *
 * ## What lives here, and what does not
 *
 * Definitions only. Nothing in this file OBSERVES anything — a producer (e.g.
 * `file-source.ts`) owns both the definition of its event and the code that
 * notices it happening, which keeps the two from drifting apart.
 */

import type { WishEventDefinition } from './types';
import { FILE_ADDED_EVENT } from './file-source';

/**
 * Every event kind Genie ships with.
 *
 * Deliberately short. `.ai/_discovery/genie-wish-triggers.md` surveys ~40
 * candidates across agent lifecycle, processes, hosting, schedules and
 * questions; each becomes an entry here the day a producer for it exists.
 * Listing an event nothing emits would be a menu item that never fires, which
 * is worse than an absent one.
 */
export const BUILT_IN_WISH_EVENTS: readonly WishEventDefinition[] = [FILE_ADDED_EVENT];

export interface WishEventRegistry {
    /** Add an event kind. Throws on a malformed or duplicate definition. */
    register(def: WishEventDefinition): void;
    get(id: string): WishEventDefinition | undefined;
    /** Every registered kind, id-sorted so callers render a stable list. */
    list(): WishEventDefinition[];
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PROP_TYPES = new Set(['string', 'number', 'boolean']);

/**
 * Validate a definition hard, at registration.
 *
 * A definition is what a filter is checked against, so a bad one does not fail
 * loudly at registration and then quietly forever after — it makes every filter
 * written against it meaningless. Cheapest place to refuse is here.
 */
function assertValid(def: WishEventDefinition): void {
    if (!def || typeof def !== 'object') {
        throw new Error('A wish event definition must be an object.');
    }
    if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) {
        throw new Error(
            `Wish event id "${String(def.id)}" is not <domain>:<event> in lower kebab-case.`,
        );
    }
    if (typeof def.label !== 'string' || def.label.trim() === '') {
        throw new Error(`Wish event "${def.id}" needs a label.`);
    }
    if (!Array.isArray(def.props)) {
        throw new Error(`Wish event "${def.id}" must declare a props array (it may be empty).`);
    }
    const seen = new Set<string>();
    for (const prop of def.props) {
        if (!prop || typeof prop.key !== 'string' || prop.key.trim() === '') {
            throw new Error(`Wish event "${def.id}" has a prop with no key.`);
        }
        if (seen.has(prop.key)) {
            throw new Error(`Wish event "${def.id}" declares prop "${prop.key}" twice.`);
        }
        seen.add(prop.key);
        if (!PROP_TYPES.has(prop.type)) {
            throw new Error(
                `Wish event "${def.id}" prop "${prop.key}" has type "${String(prop.type)}"; ` +
                    `expected string, number or boolean.`,
            );
        }
        if (typeof prop.label !== 'string' || prop.label.trim() === '') {
            throw new Error(`Wish event "${def.id}" prop "${prop.key}" needs a label.`);
        }
    }
}

/**
 * Build a registry seeded with `defs` (the built-ins by default).
 *
 * A duplicate id throws rather than overwriting: two producers emitting the same
 * id with different props would make every filter written against it depend on
 * which one loaded last, and that is a bug nobody would ever find.
 */
export function createWishEventRegistry(
    defs: readonly WishEventDefinition[] = BUILT_IN_WISH_EVENTS,
): WishEventRegistry {
    const byId = new Map<string, WishEventDefinition>();

    const registry: WishEventRegistry = {
        register(def) {
            assertValid(def);
            if (byId.has(def.id)) {
                throw new Error(`Wish event "${def.id}" is already registered.`);
            }
            byId.set(def.id, def);
        },
        get: (id) => byId.get(id),
        list: () => [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };

    for (const def of defs) registry.register(def);
    return registry;
}
