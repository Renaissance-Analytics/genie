/**
 * The Electron half of flows.
 *
 * Everything decidable lives in the pure modules beside this one and is tested
 * there; this file hands them real I/O — the database, the GApp bridge, the host
 * scheduler — and exposes the editor's operations to Genie's renderer.
 *
 * ## Two things happen at boot, in this order
 *
 * The fire handler is wired FIRST, then schedules are reconciled. A reconciliation
 * that armed timers before the handler existed would leave a window in which a
 * due flow fired into nothing and was recorded as failed — small, but exactly the
 * kind of window that shows up as one mysterious failed run after every update.
 *
 * ## What the renderer may do, and what it may not
 *
 * Genie's own UI edits flows: list, save, delete, enable, run by hand. It cannot
 * grant anything — saving a graph that reaches past the app's grant is allowed
 * (an author is mid-edit), and it is `decideFlowAdmission` that refuses to RUN
 * it. Editing is not authorising, and conflating the two would mean an author
 * could not save an unfinished flow.
 */

import { ipcMain } from 'electron';
import { getAppGrant } from '../db';
import { dispatchAppCall } from '../apps/bridge';
import { setFlowFireHandler } from '../terminal/process-scheduler';
import type { ServerDeps } from '../mcp/server';
import type { AppGrant } from '../apps/bridge-decision';
import { runStoredFlow, type FlowRunnerDeps } from './runner';
import { reconcileFlowSchedules } from './scheduler';
import { deleteFlow, getFlow, listFlowsForApp, upsertFlow } from './store';
import { listGenieNodeKinds, paletteForCapabilities } from './nodes';
import { declaredTriggers } from './triggers';
import { decideFlowAdmission } from './admission';

function grantFor(appId: string): AppGrant | null {
    const row = getAppGrant(appId);
    if (!row) return null;
    return {
        appId: row.appId,
        appName: row.name,
        workspaceId: row.workspaceId,
        scope: row.scope,
        capabilities: row.capabilities,
        revoked: row.revoked,
        ...(row.workspaces ? { workspaces: row.workspaces } : {}),
    };
}

/**
 * The runner's dependencies, bound to production.
 *
 * `dispatch` is `dispatchAppCall` — the SAME function the GApp window's bridge
 * calls. That is the whole point: a flow is another caller of the one gate, not a
 * second path to the tools behind it.
 */
function runnerDeps(deps: ServerDeps): FlowRunnerDeps {
    return {
        loadFlow: getFlow,
        loadGrant: grantFor,
        dispatch: (appId, input) => dispatchAppCall(appId, input, deps),
    };
}

export function registerFlowsIpc(deps: ServerDeps): void {
    // Wired BEFORE reconciliation, so no timer can come due without somewhere to
    // fire. See the note at the top of this file.
    setFlowFireHandler(async (flowId) => (await runStoredFlow(flowId, runnerDeps(deps))).ok);
    reconcileFlowSchedules();

    ipcMain.handle('flows:list', (_e, appId: string) =>
        listFlowsForApp(appId).map((flow) => ({
            id: flow.id,
            appId: flow.appId,
            name: flow.name,
            enabled: flow.enabled,
            updatedAt: flow.updatedAt,
            /** So the list can say "runs daily at 03:00" without loading the canvas. */
            triggers: flow.graph ? declaredTriggers(flow.graph) : [],
            /** Null graph means the row is corrupt; the UI should say so, not hide it. */
            readable: flow.graph !== null,
        })),
    );

    ipcMain.handle('flows:get', (_e, flowId: string) => getFlow(flowId));

    ipcMain.handle(
        'flows:save',
        (_e, input: { id: string; appId: string; name: string; graph: unknown; enabled?: boolean }) => {
            upsertFlow(input);
            // Every save reconciles: adding a schedule trigger arms it, removing
            // one disarms it, and editing the cron moves the timer. Nobody has to
            // remember to do it separately, which is the owner's requirement.
            reconcileFlowSchedules();
            return getFlow(input.id);
        },
    );

    ipcMain.handle('flows:delete', (_e, flowId: string) => {
        deleteFlow(flowId);
        reconcileFlowSchedules();
        return true;
    });

    ipcMain.handle('flows:set-enabled', (_e, flowId: string, enabled: boolean) => {
        const flow = getFlow(flowId);
        if (!flow) return null;
        upsertFlow({
            id: flow.id,
            appId: flow.appId,
            name: flow.name,
            graph: flow.graph ?? {},
            enabled,
        });
        reconcileFlowSchedules();
        return getFlow(flowId);
    });

    /**
     * What this graph WOULD be allowed to do — without running it.
     *
     * The editor calls this as the author works, so a refusal shows up on the
     * canvas rather than at 3am on the first scheduled fire.
     */
    ipcMain.handle('flows:check', (_e, appId: string, graph: unknown) =>
        decideFlowAdmission(graph as never, grantFor(appId)),
    );

    /**
     * The palette. Filtered to what the app was granted, so the canvas cannot
     * offer a step that is certain to be refused; the full list is there for a UI
     * that wants to show what is possible but not yet permitted.
     */
    ipcMain.handle('flows:palette', (_e, appId: string) => {
        const grant = grantFor(appId);
        return {
            available: grant && !grant.revoked ? paletteForCapabilities(grant.capabilities) : [],
            all: listGenieNodeKinds(),
        };
    });

    ipcMain.handle('flows:run', async (_e, flowId: string) =>
        runStoredFlow(flowId, runnerDeps(deps)),
    );
}
