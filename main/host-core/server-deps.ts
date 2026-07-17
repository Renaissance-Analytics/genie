import { listTerminalSpecs, getTerminalSpec, getWorkspace, listWorkspaces } from '../db';
import {
    lastActiveTerminalForWorkspace,
    broadcastTerminalAttention,
    broadcastWorkspacePulse,
} from '../terminal/ipc';
import { mobileEmit } from '../mobile/server';
import { workspaceIdOfTerminal } from '../terminal/workspace-of-terminal';
import { forceQuestion } from '../ask/force-question';
import {
    describeWorkspaceForMcp,
    checkIssuesForMcp,
    manageProcessForMcp,
    provisionWorkspacesForMcp,
    manageTerminalsForMcp,
    runAgentForMcp,
    manageWorkspacesForMcp,
    agentInboxForMcp,
    knowledgeForMcp,
    isOpsProjectFor,
    workspaceRootForTerminal,
} from '../mcp/host-tools';
import { openFileForUserForMcp } from '../editor/open-file';
import { applySetEnv, applyCheckEnv } from '../env-store';
import { pluginToolDescriptors, dispatchPluginTool } from '../plugins/registry';
import { agentInboxBroker } from '../agentinbox/broker';
import { formatAgentInboxMailLine } from '../mcp/protocol';
import type { ServerDeps } from '../mcp/server';
import type { HostCorePorts } from './ports';

/**
 * Assemble the MCP server's `ServerDeps` from the GUI-FREE, importable building
 * blocks — the extracted `*ForMcp` tools (host-tools.ts), the openFileForUser /
 * env tools, the (dual-safe) attention broadcasts, and `forceQuestion` (routed
 * through the injected QuestionTransport). The ONE Electron-shaped side effect,
 * the imDone chime/toast, goes through the injected `Notifier` port (desktop
 * wires the real notifier; headless logs / forwards).
 *
 * Both shells use this: desktop passes its Electron ports + version/port config;
 * genie-cloud passes its security ports. So the SAME deps power the MCP server
 * under Electron and headless Node — no `background.ts` required.
 */
export interface HostServerDepsConfig {
    serverVersion: string;
    userDataDir: string;
    /** The configured (user-settable) MCP port, read live from settings. */
    configuredPort: () => number;
}

export function buildHostServerDeps(
    cfg: HostServerDepsConfig,
    ports: HostCorePorts,
): ServerDeps {
    return {
        serverVersion: cfg.serverVersion,
        userDataDir: cfg.userDataDir,
        configuredPort: cfg.configuredPort,
        workspaceTerminals: (workspaceId) => ({
            ids: listTerminalSpecs()
                .filter((t) => t.workspace_id === workspaceId)
                .map((t) => t.id),
            lastActive: lastActiveTerminalForWorkspace(workspaceId),
        }),
        onImDone: (terminalId) => {
            if (!terminalId) return;
            broadcastTerminalAttention(terminalId, true);
            // Wake-on-DM idle signal (issue #9): imDone = the agent's turn ended, so
            // it's now at its prompt. A later DM may wake it IF no output follows.
            agentInboxBroker.markTurnEnd(terminalId);
            const wsId = workspaceIdOfTerminal(terminalId);
            if (wsId) broadcastWorkspacePulse(wsId);
            // The user-facing notification (chime/toast/window-flash on desktop;
            // log/forward headless) — the injected Notifier port.
            ports.notifier.imDone(terminalId);
            // Forward the chime/toast to a connected remote driver (no-op when
            // nothing is on /ws/events).
            mobileEmit('notify:imdone', { label: getTerminalSpec(terminalId)?.label });
        },
        checkIssues: (terminalId) => checkIssuesForMcp(terminalId),
        agentInboxMailLine: (terminalId) =>
            formatAgentInboxMailLine(agentInboxBroker.unreadForTerminal(terminalId)),
        onForceQuestion: (terminalId, questions) => {
            let workspaceLabel: string | undefined;
            try {
                const wsId = terminalId ? getTerminalSpec(terminalId)?.workspace_id : null;
                if (wsId) {
                    workspaceLabel = listWorkspaces().find((w) => w.id === wsId)?.project_name;
                }
            } catch {
                /* fall back to the generic title */
            }
            return forceQuestion(questions, workspaceLabel);
        },
        describeWorkspace: (terminalId) => describeWorkspaceForMcp(terminalId),
        manageProcess: (terminalId, req) => manageProcessForMcp(terminalId, req),
        provisionWorkspaces: (terminalId, req) => provisionWorkspacesForMcp(terminalId, req),
        manageTerminals: (terminalId, req) => manageTerminalsForMcp(terminalId, req),
        runAgent: (terminalId, req) => runAgentForMcp(terminalId, req),
        manageWorkspaces: (terminalId, req) => manageWorkspacesForMcp(terminalId, req),
        agentInbox: (terminalId, req) => agentInboxForMcp(terminalId, req),
        knowledge: (terminalId, req) => knowledgeForMcp(terminalId, req),
        openFileForUser: (terminalId, req) => openFileForUserForMcp(terminalId, req),
        setEnv: (terminalId, req) => {
            const root = workspaceRootForTerminal(terminalId);
            if (!root) return { ok: false, error: 'No workspace resolved for this terminal.' };
            return applySetEnv(root, req);
        },
        checkEnv: (terminalId, req) => {
            const root = workspaceRootForTerminal(terminalId);
            if (!root) return { ok: false, error: 'No workspace resolved for this terminal.' };
            return applyCheckEnv(root, req);
        },
        isOpsProject: async (terminalId) => {
            const wsId = terminalId ? getTerminalSpec(terminalId)?.workspace_id ?? null : null;
            const ws = wsId ? getWorkspace(wsId) : null;
            return ws ? isOpsProjectFor(ws.path) : false;
        },
        // Plugin System seam: enabled-plugin tools ride the SAME MCP surface.
        // Both are fail-closed inside the registry (a bad plugin contributes
        // nothing / returns a contained error), so a plugin can never poison the
        // core tool list.
        pluginTools: () => pluginToolDescriptors(),
        dispatchPluginTool: (name, args, terminalId) => dispatchPluginTool(name, args, terminalId),
    };
}
