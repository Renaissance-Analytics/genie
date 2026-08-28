/**
 * The GApp bridge — the only way out of a GApp's window (Tynn #250).
 *
 * A GApp window has no `window.genie`, no Node and no way to reach Genie's own
 * preload. What it has is one IPC channel, and this is the handler on the other
 * end of it. Everything security-shaped here is decided in pure modules that are
 * tested directly — `decideAppCall` (may this call happen?) and
 * `prepareAppToolCall` (what does it become?) — so this file is deliberately
 * boring: resolve who is calling, ask, dispatch, return.
 *
 * The one rule that lives HERE, because it cannot live anywhere else: identity
 * comes from the WINDOW, never from the page. A GApp's call is attributed by the
 * `webContents` it arrived on, which Genie created and recorded. A page that sends
 * an app id gets ignored — there is no field for it.
 */

import { ipcMain, type WebContents } from 'electron';
import { appGrantFor, appIdentityFor } from './grant-lookup';
import { decideAppCall } from './bridge-decision';
import { prepareAppToolCall } from './call-prep';
import { callerIdForApp } from '../mcp/caller-identity';
import { handleMcpMessage } from '../mcp/protocol';
import type { ServerDeps } from '../mcp/server';
// From a LEAF module, never the other way round: the preload imports these too,
// and anything reachable from it lands in a third-party sandboxed window.
import { APP_CALL_CHANNEL, APP_ME_CHANNEL } from './channels';


/** webContents id → the app whose window it is. Genie's record, not the page's. */
const windowApps = new Map<number, string>();

export function registerAppWindow(webContents: WebContents, appId: string): void {
    windowApps.set(webContents.id, appId);
    webContents.once('destroyed', () => windowApps.delete(webContents.id));
}

export function unregisterAppWindow(webContentsId: number): void {
    windowApps.delete(webContentsId);
}

/** Every window currently open for an app — used to close them on revoke/uninstall. */
export function windowIdsForApp(appId: string): number[] {
    return [...windowApps.entries()].filter(([, id]) => id === appId).map(([wcId]) => wcId);
}

export interface AppCallResult {
    ok: boolean;
    /** The tool's own result, when it ran. */
    result?: unknown;
    /** Why not, in words the user could act on. */
    error?: string;
}

/**
 * The MCP context a GApp call runs under.
 *
 * The SAME `ServerDeps` the MCP server uses, with the caller id swapped for the
 * app's. Every tool resolves its workspace through `resolveAgentTarget`, which
 * knows both caller kinds — so an app gets the real tools, under app rules, with
 * no parallel implementation to drift.
 */
function appMcpContext(deps: ServerDeps, appId: string) {
    return {
        terminalId: callerIdForApp(appId),
        serverName: 'genie',
        serverVersion: deps.serverVersion,
        onImDone: deps.onImDone,
        checkIssues: deps.checkIssues,
        agentInboxMailLine: deps.agentInboxMailLine,
        onForceQuestion: deps.onForceQuestion,
        describeWorkspace: deps.describeWorkspace,
        manageProcess: deps.manageProcess,
        manageSite: deps.manageSite,
        manageService: deps.manageService,
        devServerAvailable: deps.devServerAvailable,
        provisionWorkspaces: deps.provisionWorkspaces,
        manageTerminals: deps.manageTerminals,
        registerAgent: deps.registerAgent,
        runAgent: deps.runAgent,
        manageWorkspaces: deps.manageWorkspaces,
        agentInbox: deps.agentInbox,
        knowledge: deps.knowledge,
        openFileForUser: deps.openFileForUser,
        setEnv: deps.setEnv,
        checkEnv: deps.checkEnv,
        submitFeedback: deps.submitFeedback,
        isOpsProject: deps.isOpsProject,
        pluginTools: deps.pluginTools,
        dispatchPluginTool: deps.dispatchPluginTool,
    };
}

export async function dispatchAppCall(
    appId: string,
    input: { tool: unknown; args: unknown; workspaceId: unknown },
    deps: ServerDeps,
): Promise<AppCallResult> {
    const tool = typeof input.tool === 'string' ? input.tool : '';
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : undefined;

    const decision = decideAppCall({ tool, workspaceId }, appGrantFor(appId));
    if (!decision.allowed) return { ok: false, error: decision.reason };

    const message = prepareAppToolCall(decision, { tool, args: input.args });
    try {
        const response = await handleMcpMessage(message, appMcpContext(deps, appId));
        if (response && 'error' in response && response.error) {
            return { ok: false, error: response.error.message };
        }
        return { ok: true, result: response && 'result' in response ? response.result : undefined };
    } catch (e) {
        // A throwing tool must not take the main process down with it, and the app
        // must not learn anything from a stack trace it did not already know.
        return { ok: false, error: e instanceof Error ? e.message : 'The call failed.' };
    }
}

/**
 * Wire the bridge. Called once at boot, with the same deps the MCP server got.
 */
export function registerAppBridge(deps: ServerDeps): void {
    ipcMain.handle(APP_CALL_CHANNEL, async (event, raw: unknown) => {
        const appId = windowApps.get(event.sender.id);
        // Not a GApp window Genie opened. There is no recovery from this and no
        // useful detail to give: something is calling a channel it should not know.
        if (!appId) return { ok: false, error: 'This window is not a Genie App window.' };

        const input = (raw ?? {}) as { tool?: unknown; args?: unknown; workspaceId?: unknown };
        return dispatchAppCall(
            appId,
            { tool: input.tool, args: input.args, workspaceId: input.workspaceId },
            deps,
        );
    });

    ipcMain.handle(APP_ME_CHANNEL, (event) => {
        const appId = windowApps.get(event.sender.id);
        // What the app is allowed to know about itself: who it is, and what it may
        // do — so it can hide a feature it was not granted instead of offering a
        // button that fails. Decided in `preview-registry.ts`, because a PREVIEWED
        // app's identity and its authority come from two different places and
        // getting that split wrong is not visible from here.
        return appId ? appIdentityFor(appId) : null;
    });
}
