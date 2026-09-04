/**
 * Genie Wishes, bound to the real machine.
 *
 * Everything decidable lives in the pure modules beside this one and is tested
 * there. This file hands them real I/O — the database, the filesystem watcher,
 * node's `fs` — and is deliberately boring: build the registry, build the
 * runtime, work out which workspaces to watch, start watching.
 *
 * ## Order matters at boot
 *
 * The file source is subscribed BEFORE any workspace is watched. Watching first
 * would open a window in which a file landed, the watcher reported it, and
 * nothing was listening — a Wish that silently did not fire for the one file
 * that arrived during startup, which is exactly the kind of gap that shows up
 * later as "it works except sometimes".
 *
 * ## What is NOT here yet
 *
 * There is no IPC and no UI, so nothing in the app can currently CREATE a Wish —
 * the grouped menu (users and agents, grouped by purpose, sorted by trigger) and
 * GApp-authored Wishes are both deferred. The model, the store and the runtime
 * are complete and tested, so the menu plugs into `store.ts` and
 * `match.isWishVisibleTo` when it lands rather than needing either rewritten. A
 * half-built creation surface would have been worse than an absent one.
 */

import fs from 'node:fs';
import { listWorkspaces } from '../db';
import { onFileWatchEvent, unwatchWorkspace, watchWorkspace } from '../files/watch';
import { BUILT_IN_WISH_RECIPES } from './builtin-recipes';
import { createWishEventRegistry, type WishEventRegistry } from './events';
import { startWishFileSource } from './file-source';
import { WishLoopGuard } from './loop';
import { WishRuntime } from './runtime';
import { listWishes } from './store';
import { planWishFileWatches, type WatchableWorkspace } from './watch-plan';

let registry: WishEventRegistry | null = null;
let runtime: WishRuntime | null = null;
let stopSource: (() => void) | null = null;
/**
 * Watched root → workspace id, for the roots THIS module asked for.
 *
 * Doubles as the record of which references to release, and as the lookup the
 * file source uses. It must not be a database query: the source is called once
 * per raw filesystem event, and an `npm install` in a watched workspace would
 * otherwise mean thousands of `SELECT`s for events that are about to be dropped
 * anyway. The map is rebuilt when the plan changes, which is the only time it
 * can go stale.
 */
let watched = new Map<string, string>();

/** The one registry for this process. Built lazily so tests never share it. */
export function wishEventRegistry(): WishEventRegistry {
    if (!registry) registry = createWishEventRegistry();
    return registry;
}

/** The dispatcher, or null before {@link startWishes}. */
export function wishRuntime(): WishRuntime | null {
    return runtime;
}

/** `null` when the path is gone or unreadable — never throws. */
function statFile(absPath: string): { isFile: boolean; size: number } | null {
    try {
        const s = fs.statSync(absPath);
        return { isFile: s.isFile(), size: s.size };
    } catch {
        return null;
    }
}

function watchableWorkspaces(): WatchableWorkspace[] {
    return listWorkspaces()
        .filter((w) => typeof w.path === 'string' && w.path !== '')
        .map((w) => ({ id: w.id, path: w.path }));
}

/**
 * Watch exactly the workspaces the stored Wishes need, and no others.
 *
 * Safe to call again: references this module holds are released before the new
 * plan is taken, so a Wish being disabled actually stops the watcher rather than
 * leaving it running until the next restart. Panels hold their OWN references,
 * so a workspace open in the Code view keeps its watcher either way.
 */
export function reconcileWishWatches(): void {
    const plan = planWishFileWatches(listWishes(), watchableWorkspaces(), wishEventRegistry());
    const next = new Map(plan.map((w) => [w.path, w.id]));

    for (const root of watched.keys()) {
        if (!next.has(root)) unwatchWorkspace(root);
    }
    for (const root of next.keys()) {
        if (!watched.has(root)) watchWorkspace(root);
    }
    watched = next;
}

/**
 * Start reacting to system events. Returns the teardown.
 *
 * Idempotent: calling it twice does not open a second source or double-count
 * watch references.
 */
export function startWishes(): () => void {
    if (stopSource) return stopWishes;

    const rt = new WishRuntime({
        registry: wishEventRegistry(),
        guard: new WishLoopGuard(),
        listWishes,
        resolveRecipe: (ref) => BUILT_IN_WISH_RECIPES.get(ref.recipeId) ?? null,
        onLog: (log) => {
            // A Wish that did not fire is the hardest thing here to debug, so
            // every outcome is said out loud — including the refusals.
            if (log.outcome === 'ran') return;
            console.log(
                `[wishes] ${log.wishId} ${log.outcome}` +
                    (log.event ? ` (${log.event})` : '') +
                    (log.reason ? `: ${log.reason}` : ''),
            );
        },
    });
    runtime = rt;

    // Subscribed BEFORE anything is watched — see the note at the top.
    stopSource = startWishFileSource({
        subscribe: onFileWatchEvent,
        statFile,
        workspaceIdFor: (workspacePath) => watched.get(workspacePath),
        emit: (event) => rt.emit(event).then(() => undefined),
    });

    reconcileWishWatches();
    return stopWishes;
}

/** Release every watcher this module took, and stop the source. */
export function stopWishes(): void {
    stopSource?.();
    stopSource = null;
    runtime = null;
    for (const root of watched.keys()) unwatchWorkspace(root);
    watched = new Map();
}

export * from './types';
export { createWishEventRegistry, BUILT_IN_WISH_EVENTS } from './events';
export { matchesWishFilter, validateWishFilter, WishFilterError } from './filter';
export { isWishVisibleTo, isManuallyRunnable, selectWishesForEvent } from './match';
export { decideWishAdmission, UNATTENDED_SAFE_STEP_TYPES } from './admission';
export { WishLoopGuard } from './loop';
export { WishRuntime, type WishRunLog } from './runtime';
export {
    listWishes,
    getWish,
    upsertWish,
    deleteWish,
    setWishEnabled,
    validateWish,
} from './store';
export {
    RELOCATE_FILE_RECIPE_ID,
    RELOCATION_DIR_ARG,
    DEFAULT_RELOCATION_DIR,
    BUILT_IN_WISH_RECIPES,
} from './builtin-recipes';
export { FILE_ADDED_EVENT } from './file-source';
