/**
 * PURE. Which workspaces need a filesystem watcher, given what the Flows say.
 *
 * A recursive `fs.watch` is not free — it holds OS handles and fires on every
 * build, install and checkout — so Genie does not watch a workspace on the
 * chance somebody might one day write a file Flow. The watch set is derived from
 * the declarations, the way `main/apps/flows/schedule-plan.ts` derives which cron
 * timers should exist from what the graphs declare.
 *
 * ## The event ids come from the registry, not from here
 *
 * A producer says which events it can emit; this asks the registry which of a
 * Flow's triggers that producer covers. So a second file-shaped producer added
 * later widens the watch plan by being registered, not by anyone remembering to
 * edit this list.
 */

import { FILE_ADDED_EVENT } from './file-source';
import type { FlowEventRegistry } from './events';
import type { Flow } from './types';

/** The minimum this needs to know about a workspace. */
export interface WatchableWorkspace {
    id: string;
    path: string;
}

/**
 * Event kinds that only exist while a workspace is being watched.
 *
 * One entry today. It is a set rather than a comparison because the next
 * file-shaped event (`files:removed`, `files:changed`) should widen the plan by
 * appearing here, beside the producer that emits it.
 */
const WATCH_BACKED_EVENTS: ReadonlySet<string> = new Set([FILE_ADDED_EVENT.id]);

/**
 * The workspaces to watch, in the order they were given.
 *
 * A trigger naming an event the registry does not know is ignored: it cannot
 * fire, so watching for it would be pure cost. A workspace-scoped Flow pointing
 * at a workspace that no longer exists is ignored for the same reason.
 */
export function planFlowFileWatches(
    flows: readonly Flow[],
    workspaces: readonly WatchableWorkspace[],
    registry: FlowEventRegistry,
): WatchableWorkspace[] {
    const wanted = new Set<string>();
    let all = false;

    for (const flow of flows) {
        if (!flow.enabled) continue;
        const watchBacked = flow.triggers.some(
            (t) =>
                t.kind === 'event' &&
                WATCH_BACKED_EVENTS.has(t.event) &&
                registry.get(t.event) !== undefined,
        );
        if (!watchBacked) continue;

        if (flow.scope.kind === 'workspace') {
            wanted.add(flow.scope.workspaceId);
        } else {
            // A system- or gapp-scoped Flow reacts to files anywhere, which
            // is what "a file added anywhere in a workspace" asks for.
            all = true;
        }
    }

    if (!all && wanted.size === 0) return [];
    return workspaces.filter((w) => all || wanted.has(w.id));
}
