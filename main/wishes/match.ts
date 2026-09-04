/**
 * PURE. Which Wishes an event selects, and who may see a Wish at all.
 *
 * Two questions that look unrelated and are the same question: both are
 * answered from the Wish's `scope`, and both are answered HERE rather than in
 * whichever surface is asking. A menu that decided visibility for itself would
 * be a second implementation of an authorisation rule, and the second
 * implementation is the one that gets it wrong.
 *
 * Nothing in this file knows an event kind. It is handed a registry and asks it
 * questions; an event it has never heard of is refused with a reason, not
 * guessed at. That is the property `__tests__/extensible-events.test.ts` pins
 * down structurally.
 */

import { matchesWishFilter, WishFilterError } from './filter';
import type { WishEventRegistry } from './events';
import type { Wish, WishEvent, WishEventTrigger } from './types';

export interface WishTriggerMatch {
    wish: Wish;
    trigger: WishEventTrigger;
}

/** A Wish that WANTED this event but could not be judged. Never silent. */
export interface WishMatchProblem {
    wishId: string;
    event: string;
    reason: string;
}

export interface WishSelection {
    matches: WishTriggerMatch[];
    problems: WishMatchProblem[];
}

/**
 * The workspace an event happened in, when it names one.
 *
 * Read by convention from a `workspaceId` prop rather than a field on the event,
 * because plenty of event kinds have no workspace at all (a machine woke up, an
 * upgrade landed) and a required field would force every producer to invent one.
 */
export const WORKSPACE_PROP = 'workspaceId';

function eventWorkspaceId(event: WishEvent): string | undefined {
    const v = event.props[WORKSPACE_PROP];
    return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Whether this Wish is allowed to react to this event AT ALL, before any filter.
 *
 * A workspace-scoped Wish only ever sees its own workspace's events. That is the
 * difference between "runs when a file lands in this project" and "runs when a
 * file lands in any project on the machine", and getting it wrong means a Wish
 * quietly acting on somebody else's repository. An event that names NO workspace
 * cannot be shown to be in scope, so it is not — fail closed.
 */
export function eventInScope(wish: Wish, event: WishEvent): boolean {
    if (wish.scope.kind !== 'workspace') return true;
    return eventWorkspaceId(event) === wish.scope.workspaceId;
}

/**
 * Every (wish, trigger) pair this event fires, plus every Wish that wanted it
 * and could not be judged.
 *
 * Disabled Wishes are skipped silently — that is what disabled means. A Wish
 * whose trigger names an unregistered event is skipped silently too: it is
 * ARMED for something this build does not emit (a GApp uninstalled, a producer
 * not yet shipped), which is a fact about the machine rather than a fault. A
 * filter that cannot be EVALUATED is a fault, and is reported.
 */
export function selectWishesForEvent(
    wishes: readonly Wish[],
    event: WishEvent,
    registry: WishEventRegistry,
): WishSelection {
    const matches: WishTriggerMatch[] = [];
    const problems: WishMatchProblem[] = [];

    if (!registry.get(event.event)) return { matches, problems };

    for (const wish of wishes) {
        if (!wish.enabled) continue;
        if (!eventInScope(wish, event)) continue;

        for (const trigger of wish.triggers) {
            if (trigger.kind !== 'event' || trigger.event !== event.event) continue;
            try {
                if (matchesWishFilter(trigger.filter, event.props)) {
                    matches.push({ wish, trigger });
                }
            } catch (e) {
                problems.push({
                    wishId: wish.id,
                    event: event.event,
                    reason:
                        e instanceof WishFilterError
                            ? e.message
                            : `filter could not be evaluated: ${e instanceof Error ? e.message : String(e)}`,
                });
            }
            // One match per Wish per event: two triggers on the same event kind
            // are alternatives ("either of these"), not two runs.
            if (matches[matches.length - 1]?.wish === wish) break;
        }
    }

    return { matches, problems };
}

/** Who is asking to see a Wish. A GApp asks as itself; everything else does not. */
export type WishViewer = { kind: 'workstation' } | { kind: 'app'; appId: string };

/**
 * Whether `viewer` may see `wish` in a menu.
 *
 * The one rule with teeth: a GApp Wish marked `internal` appears in NO menu
 * outside its own GApp. Enforced here so the (deferred) grouped menu, an agent's
 * tool list and anything else added later all read the same answer.
 */
export function isWishVisibleTo(wish: Wish, viewer: WishViewer): boolean {
    if (wish.scope.kind !== 'app') return true;
    if (wish.scope.exposure === 'workstation') return true;
    return viewer.kind === 'app' && viewer.appId === wish.scope.appId;
}

/** True when a human can start this Wish by hand. */
export function isManuallyRunnable(wish: Wish): boolean {
    return wish.enabled && wish.triggers.some((t) => t.kind === 'manual');
}
