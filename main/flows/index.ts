/**
 * Genie Flows, bound to the real machine.
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
 * nothing was listening — a Flow that silently did not fire for the one file
 * that arrived during startup, which is exactly the kind of gap that shows up
 * later as "it works except sometimes".
 *
 * ## What is here now, and what is still not
 *
 * The Flow Manager reads this module over `flows:*` IPC: {@link flowSummaries}
 * for the list, {@link runFlowManually} to start one by hand, and
 * `flows:activity` for what is running. Run history is persisted
 * (`run-store.ts`) rather than logged and lost, which is what makes "last
 * outcome" answerable at all.
 *
 * Authoring goes through {@link saveFlowDraft} — one entry point for the Flow
 * Manager's editor and for an agent over IPC, so the rule that a new Flow is
 * born disarmed is enforced once rather than trusted to each caller
 * (`authoring.ts`).
 *
 * Still deferred (genie#394 phase 2): GApp-AUTHORED Flows. A GApp cannot ship
 * or install one of its own; a person can scope a Flow to an installed GApp,
 * which is a different thing.
 */

import fs from 'node:fs';
import { listAppGrants, listWorkspaces } from '../db';
import { onFileWatchEvent, unwatchWorkspace, watchWorkspace } from '../files/watch';
import { broadcastLocal } from '../remote';
import { FlowActivity } from './activity';
import {
    planFlowSave,
    summariseFlowRecipes,
    type FlowDraft,
    type FlowRecipeSummary,
} from './authoring';
import { BUILT_IN_FLOW_RECIPES, resolveBuiltInRecipe } from './builtin-recipes';
import { createFlowEventRegistry, type FlowEventRegistry } from './events';
import { startFlowFileSource } from './file-source';
import { FlowLoopGuard } from './loop';
import {
    deleteFlowRuns,
    lastFlowRuns,
    pruneFlowRuns,
    reconcileInterruptedFlowRuns,
    recordFlowRun,
    recordFlowRunStart,
    type FlowRunRecord,
} from './run-store';
import { FlowRuntime, type FlowRunLog } from './runtime';
import { deleteFlow, getFlow, listFlows, upsertFlow } from './store';
import { summariseFlows, type FlowSummary } from './summary';
import { planFlowFileWatches, type WatchableWorkspace } from './watch-plan';

let registry: FlowEventRegistry | null = null;
let stopSource: (() => void) | null = null;

/**
 * Live run state for this process.
 *
 * Module-level rather than built inside {@link startFlows}, because the Flow
 * Manager asks for a snapshot on mount — a broadcast reaches nobody if no window
 * was open when it fired, and nothing replays it (see `broadcastLocal`). So the
 * surface FETCHES then SUBSCRIBES; this is what the fetch reads.
 */
const activity = new FlowActivity();

/** The one runtime, so IPC can start a Flow by hand through the same gates. */
let runtime: FlowRuntime | null = null;
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
export function flowEventRegistry(): FlowEventRegistry {
    if (!registry) registry = createFlowEventRegistry();
    return registry;
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
 * Watch exactly the workspaces the stored Flows need, and no others.
 *
 * Safe to call again: references this module holds are released before the new
 * plan is taken, so a Flow being disabled actually stops the watcher rather than
 * leaving it running until the next restart. Panels hold their OWN references,
 * so a workspace open in the Code view keeps its watcher either way.
 */
export function reconcileFlowWatches(): void {
    const plan = planFlowFileWatches(listFlows(), watchableWorkspaces(), flowEventRegistry());
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
export function startFlows(): () => void {
    if (stopSource) return stopFlows;

    // BEFORE the runtime exists, so nothing this process starts can be caught by
    // it. At this instant nothing is running, which is what makes a `running`
    // row orphaned by definition rather than by a guess about its age — no
    // heuristic, no grace period, no window where a live run looks dead.
    try {
        const orphaned = reconcileInterruptedFlowRuns();
        if (orphaned > 0) {
            console.log(
                `[flows] ${orphaned} run${orphaned === 1 ? '' : 's'} were in progress when ` +
                    `Genie last stopped; marked interrupted.`,
            );
        }
    } catch (e) {
        console.log(`[flows] could not reconcile interrupted runs: ${String(e)}`);
    }

    const rt = new FlowRuntime({
        registry: flowEventRegistry(),
        guard: new FlowLoopGuard(),
        listFlows,
        resolveRecipe: resolveBuiltInRecipe,
        onRunStart: (start) => {
            activity.started(start);
            // Persisted at the START as well as the finish. Not for the header —
            // that reads the in-memory map, which a crash takes with it — but so
            // a run cut short by one leaves a trace instead of vanishing from
            // the history entirely. Boot turns whatever is left into
            // `interrupted`.
            try {
                recordFlowRunStart(start);
            } catch (e) {
                console.log(`[flows] could not record start ${start.runId}: ${String(e)}`);
            }
            pushFlowActivity();
        },
        onLog: (log) => {
            // A Flow that did not fire is the hardest thing here to debug, so
            // every outcome is said out loud — including the refusals.
            if (log.outcome !== 'ran') {
                console.log(
                    `[flows] ${log.flowId} ${log.outcome}` +
                        (log.event ? ` (${log.event})` : '') +
                        (log.reason ? `: ${log.reason}` : ''),
                );
            }
            recordRun(log);
        },
    });
    runtime = rt;

    // Subscribed BEFORE anything is watched — see the note at the top.
    stopSource = startFlowFileSource({
        subscribe: onFileWatchEvent,
        statFile,
        workspaceIdFor: (workspacePath) => watched.get(workspacePath),
        emit: (event) => rt.emit(event).then(() => undefined),
    });

    reconcileFlowWatches();
    return stopFlows;
}

/** Release every watcher this module took, and stop the source. */
export function stopFlows(): void {
    stopSource?.();
    stopSource = null;
    runtime = null;
    for (const root of watched.keys()) unwatchWorkspace(root);
    watched = new Map();
}

/* ===== live state, history, and the surfaces that read them ============ */

/**
 * Tell every local window what is running.
 *
 * Push, never poll — the header button animates off this, and an interval that
 * asked "anything running?" would both lag the thing it reports and keep the
 * process awake to say "no" all night.
 *
 * `finished` rides along on the closing push so an open manager can update that
 * row's outcome without a round trip. The channel is local-only, like
 * `knowledge:changed`: a Flow ran on THIS machine and there is nothing here for
 * a relayed window to learn.
 */
function pushFlowActivity(finished?: FlowRunRecord): void {
    broadcastLocal('flows:activity', {
        running: activity.runningFlowIds(),
        busy: activity.isBusy(),
        ...(finished ? { finished } : {}),
    });
}

/** Something about the STORED Flows changed; a manager should re-read. */
export function pushFlowsChanged(): void {
    broadcastLocal('flows:changed', {});
}

/**
 * Close a run out: clear its live state, keep its outcome, tell the windows.
 *
 * A failure to WRITE the history must not become a failure of the run itself —
 * this is called from the runtime's own log callback, and throwing here would
 * turn "the disk is full" into "the dispatcher crashed mid-event".
 */
function recordRun(log: FlowRunLog): void {
    const record = activity.finished(log);
    try {
        recordFlowRun(record);
        // Cheap, and only on the way out of a run, so history cannot creep past
        // the cap between restarts on a machine that is never restarted.
        pruneFlowRuns();
    } catch (e) {
        console.log(`[flows] could not record run ${record.runId}: ${String(e)}`);
    }
    pushFlowActivity(record);
}

/** What is running right now — the snapshot a surface fetches on mount. */
export function flowActivitySnapshot(): { running: string[]; busy: boolean } {
    return { running: activity.runningFlowIds(), busy: activity.isBusy() };
}

/**
 * Every Flow, joined with its scope's real name, its triggers' registry
 * entries, its last run and whether it is running.
 *
 * Workspace and app names are resolved HERE rather than renderer-side: a
 * workspace that has been removed is the difference between a Flow that is quiet
 * and one that can never fire again, and that judgement belongs beside the
 * matcher that makes it, not in a component.
 */
/** App id → name, for the apps a Flow may be scoped to. Revoked ones are gone. */
function installedAppNames(): Map<string, string> {
    return new Map(
        listAppGrants()
            .filter((a) => !a.revoked)
            .map((a) => [a.appId, a.name]),
    );
}

export function flowSummaries(): FlowSummary[] {
    const workspaceNames = new Map(listWorkspaces().map((w) => [w.id, w.project_name]));
    const appNames = installedAppNames();
    // Read off the recipes themselves, so what the manager warns about and what
    // the body actually does cannot drift apart.
    const recipeConsequences = new Map(
        [...BUILT_IN_FLOW_RECIPES.values()]
            .filter((r) => typeof r.consequence === 'string' && r.consequence !== '')
            .map((r) => [r.id, r.consequence as string]),
    );
    return summariseFlows(listFlows(), {
        registry: flowEventRegistry(),
        workspaceNames,
        appNames,
        lastRuns: lastFlowRuns(),
        runningFlowIds: activity.runningFlowIds(),
        recipeConsequences,
    });
}

/* ===== authoring ======================================================= */

/**
 * The bodies a Flow may be given, serializable.
 *
 * A `FlowRecipe` carries `run` functions and cannot cross IPC, so the authoring
 * surface is handed the declared subset: title, consequence, inputs, and
 * whether a system trigger could ever execute it. Adding a second recipe adds a
 * card to the picker and nothing else.
 */
export function flowRecipeCatalogue(): FlowRecipeSummary[] {
    return summariseFlowRecipes(BUILT_IN_FLOW_RECIPES.values());
}

/** The things a Flow can be scoped TO, named as the user knows them. */
export function flowScopeChoices(): {
    workspaces: { id: string; name: string }[];
    apps: { id: string; name: string }[];
} {
    return {
        workspaces: listWorkspaces()
            .filter((w) => typeof w.path === 'string' && w.path !== '')
            .map((w) => ({ id: w.id, name: w.project_name })),
        apps: [...installedAppNames()].map(([id, name]) => ({ id, name })),
    };
}

export type FlowSaveResult =
    | { ok: true; flow: FlowSummary; disarmed: boolean }
    | { ok: false; errors: string[] };

/**
 * Create or update a Flow — the ONE way anything in Genie authors one.
 *
 * The renderer's editor and an agent reaching IPC both land here, so the two
 * rules that make an authored Flow safe hold for both: a new Flow is created
 * DISARMED, and an edit that changes what an armed Flow does — or where it may
 * act — turns it off (`authoring.ts`). Neither is something a caller can opt
 * out of; there is no `enabled` on a draft to set.
 *
 * Watches are reconciled after the write for the same reason `flows:set-enabled`
 * does it: a Flow saved with a file trigger must actually start watching, not
 * wait for the next restart.
 */
export function saveFlowDraft(draft: FlowDraft): FlowSaveResult {
    const plan = planFlowSave(draft, {
        registry: flowEventRegistry(),
        resolveRecipe: resolveBuiltInRecipe,
        existing: draft.id ? getFlow(draft.id) : null,
        taken: new Set(listFlows().map((f) => f.id)),
    });
    if (!plan.ok) return plan;

    upsertFlow(plan.flow, flowEventRegistry(), resolveBuiltInRecipe);
    reconcileFlowWatches();
    pushFlowsChanged();

    const summary = flowSummaries().find((f) => f.id === plan.flow.id);
    if (!summary) {
        // Unreachable: it was just written, and `summariseFlows` skips only a
        // row it cannot parse. Reported rather than asserted, because a save
        // that SUCCEEDED must not come back as a failure.
        return { ok: false, errors: ['the Flow was saved but could not be read back.'] };
    }
    return { ok: true, flow: summary, disarmed: plan.disarmed };
}

/**
 * Remove a Flow and the history that belonged to it.
 *
 * The runs go with it explicitly: `flow_runs` has no foreign key on purpose
 * (migration v70 — a cascade would turn a delete mid-run into a throw on the
 * path whose whole job is to report what happened), so nothing else would ever
 * collect them.
 */
export function removeFlow(flowId: string): { ok: boolean } {
    deleteFlow(flowId);
    deleteFlowRuns(flowId);
    reconcileFlowWatches();
    pushFlowsChanged();
    return { ok: true };
}

/**
 * Start a Flow by hand, through the same runtime the triggers use.
 *
 * Refuses rather than throws when Flows are not running (the manager can be open
 * in a window while the subsystem is stopped), because "nothing is listening" is
 * an outcome the surface should show like any other refusal.
 */
export async function runFlowManually(flowId: string): Promise<FlowRunLog> {
    if (!runtime) {
        return {
            flowId,
            runId: 'no-runtime',
            outcome: 'refused',
            reason: 'the Flow runtime is not running.',
            at: Date.now(),
        };
    }
    return runtime.runManually(flowId);
}

export * from './types';
export { createFlowEventRegistry, BUILT_IN_FLOW_EVENTS } from './events';
export {
    matchesFlowFilter,
    validateFlowFilter,
    FlowFilterError,
    FLOW_FILTER_OPERATORS,
    type FlowOperatorSpec,
} from './filter';
export { isFlowVisibleTo, isManuallyRunnable, selectFlowsForEvent } from './match';
export { decideFlowAdmission, UNATTENDED_SAFE_STEP_TYPES } from './admission';
export { FlowLoopGuard } from './loop';
export { FlowRuntime, type FlowRunLog, type FlowRunStart } from './runtime';
export { FlowActivity, type FlowRunRecord } from './activity';
export { summariseFlows, type FlowSummary, type FlowSummaryTrigger } from './summary';
export {
    listFlowRuns,
    lastFlowRuns,
    recordFlowRun,
    recordFlowRunStart,
    reconcileInterruptedFlowRuns,
    pruneFlowRuns,
    deleteFlowRuns,
    FLOW_RUNS_KEPT_PER_FLOW,
    type FlowRunStatus,
} from './run-store';
export { listFlows, getFlow, upsertFlow, deleteFlow, setFlowEnabled } from './store';
export {
    buildFlow,
    newFlowId,
    planFlowSave,
    recipeErrors,
    suggestFlowPurpose,
    summariseFlowRecipe,
    summariseFlowRecipes,
    validateFlow,
    type FlowDraft,
    type FlowRecipeResolver,
    type FlowRecipeSummary,
    type FlowSavePlan,
} from './authoring';
export {
    RELOCATE_FILE_RECIPE_ID,
    RELOCATION_DIR_ARG,
    DEFAULT_RELOCATION_DIR,
    BUILT_IN_FLOW_RECIPES,
    resolveBuiltInRecipe,
} from './builtin-recipes';
export { FILE_ADDED_EVENT } from './file-source';
