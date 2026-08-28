import {
    listTerminalSpecs,
    getTerminalSpec,
    getWorkspace,
    listWorkspaces,
    getDb,
    markWorkspaceAgentReadyByTerminal,
} from '../db';
import {
    lastActiveTerminalForWorkspace,
    broadcastTerminalAttention,
    broadcastWorkspacePulse,
    broadcastAgentThumbsUp,
} from '../terminal/ipc';
import { mobileEmit } from '../mobile/server';
import {
    workspaceIdOfTerminal,
    workspaceIdOfSpec,
    SYSTEM_WORKSPACE_ID,
} from '../terminal/workspace-of-terminal';
import { forceQuestion } from '../ask/force-question';
import {
    describeWorkspaceForMcp,
    checkIssuesForMcp,
    manageProcessForMcp,
    provisionWorkspacesForMcp,
    manageTerminalsForMcp,
    registerAgentForMcp,
    runAgentForMcp,
    manageWorkspacesForMcp,
    agentInboxForMcp,
    knowledgeForMcp,
    isOpsProjectFor,
    workspaceRootForTerminal,
} from '../mcp/host-tools';
import { devServerAvailableForMcp, manageSiteForMcp } from '../mcp/dev-site-tools';
import { manageGappDevForMcp } from '../mcp/gapp-dev-tools';
import { manageServiceForMcp } from '../mcp/dev-service-tools';
import { openFileForUserForMcp } from '../editor/open-file';
import { applySetEnv, applyCheckEnv } from '../env-store';
import { pluginToolDescriptors, dispatchPluginTool } from '../plugins/registry';
import { agentInboxBroker } from '../agentinbox/broker';
import { agentPulse } from '../terminal/agent-pulse';
import { backendOfKind } from '../backend/registry';
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
            if (wsId) {
                broadcastWorkspacePulse(wsId);
                // Turn ended → drop the mid-turn AgentPulse glow (the byte ring/idle
                // path handles genuine output activity separately).
                agentPulse.noteAgentIdle(wsId, terminalId);
            }
            // The user-facing notification (chime/toast/window-flash on desktop;
            // log/forward headless) — the injected Notifier port.
            ports.notifier.imDone(terminalId);
            // Forward the chime/toast to a connected remote driver (no-op when
            // nothing is on /ws/events). The WORKSPACE and AGENT ride along: a
            // driver naming only the host says "a terminal, somewhere over
            // there", which is the same anonymity the local toast had. An older
            // driver ignores the extra fields; an older HOST sends only `label`
            // and the driver degrades to it.
            const spec = terminalId ? getTerminalSpec(terminalId) : null;
            const wsForNotice = spec ? workspaceIdOfSpec(spec) : null;
            mobileEmit('notify:imdone', {
                label: spec?.label,
                workspace:
                    wsForNotice && wsForNotice !== SYSTEM_WORKSPACE_ID
                        ? getWorkspace(wsForNotice)?.project_name ?? null
                        : wsForNotice
                          ? 'System Workspace'
                          : null,
                // provider + NAME only — the chat id is addressing, never display.
                agent: spec?.meta?.agent
                    ? { provider: spec.meta.agent, name: spec.meta.whisper_purpose ?? '' }
                    : null,
            });
        },
        onThumbsUp: async (terminalId, reason, to) => {
            const agent = markWorkspaceAgentReadyByTerminal(getDb(), terminalId);
            if (!agent) {
                return { ok: false, error: 'This terminal is not bound to a registered AMS agent.' };
            }
            broadcastAgentThumbsUp({
                agentId: agent.id,
                terminalId,
                workspaceId: agent.workspace_id,
                reason,
                ...(to ? { to } : {}),
            });
            return { ok: true, agentId: agent.id };
        },
        checkIssues: (terminalId) => checkIssuesForMcp(terminalId),
        agentInboxMailLine: (terminalId) =>
            formatAgentInboxMailLine(agentInboxBroker.unreadForTerminal(terminalId)),
        onForceQuestion: (terminalId, questions, priority) => {
            let workspaceLabel: string | undefined;
            let workspaceId: string | undefined;
            try {
                const wsId = terminalId ? getTerminalSpec(terminalId)?.workspace_id : null;
                if (wsId) {
                    workspaceId = wsId;
                    workspaceLabel = listWorkspaces().find((w) => w.id === wsId)?.project_name;
                }
            } catch {
                /* fall back to the generic title */
            }
            // Pass the workspace scope so a per-workspace/-workstation DND setting is
            // honored (PendingQuestions UX). Absent workspace ⇒ global availability.
            // Pass the asking terminal so a DND-deferred answer is delivered back to
            // THIS agent's AgentInbox (ping/poll/pull) instead of being dropped.
            return forceQuestion(questions, workspaceLabel, priority, { workspaceId }, terminalId);
        },
        describeWorkspace: (terminalId) => describeWorkspaceForMcp(terminalId),
        manageProcess: (terminalId, req) => manageProcessForMcp(terminalId, req),
        // The container Dev Server (#234 P2). Both shells get it: the runtime
        // abstraction is the same Docker on a cloud workstation as on a desktop,
        // so a headless host serves a workspace's sites identically. `open` is
        // the one desktop-shaped action, and it is an injected seam that says so
        // when absent rather than silently doing nothing.
        manageSite: (terminalId, req) => manageSiteForMcp(terminalId, req),
        // The Dev Server's backing services (#234 P3). Both shells again: a
        // shared engine is the same container on a cloud workstation as on a
        // desktop, and nothing here is GUI-shaped.
        manageService: (terminalId, req) => manageServiceForMcp(terminalId, req),
        devServerAvailable: () => devServerAvailableForMcp(),
        // GApp Development Workspaces (genie#245). BOTH shells get it: `status`
        // and `check` are pure db+filesystem reads, and a headless host is a
        // perfectly good place to check an app. Only `preview` needs a window,
        // and that half is an injected port the desktop shell registers —
        // absent, the tool SAYS a preview cannot open here rather than doing
        // nothing, which is the failure this whole surface is a reaction to.
        manageGappDev: (terminalId, req) => manageGappDevForMcp(terminalId, req),
        provisionWorkspaces: (terminalId, req) => provisionWorkspacesForMcp(terminalId, req),
        manageTerminals: (terminalId, req) => manageTerminalsForMcp(terminalId, req),
        registerAgent: (terminalId, req) => registerAgentForMcp(terminalId, req),
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
        // FEEDBACK about Genie itself, into the workspace's Tynn project (Tynn
        // #249). The context is stamped HERE rather than asked of the agent: an
        // agent reporting its own version and workspace would be reporting what it
        // believes, and the useful facts are the ones Genie knows for certain.
        submitFeedback: async (terminalId, message) => {
            const wsId = terminalId ? getTerminalSpec(terminalId)?.workspace_id ?? null : null;
            const ws = wsId ? getWorkspace(wsId) : null;
            if (!ws) {
                return { ok: false, error: 'This terminal is not attached to a Genie workspace.' };
            }
            // A workspace not connected to a Tynn project has nowhere to file to,
            // and saying so is better than filing into a project nobody expects.
            const projectId = ws.tynn_project_id ?? ws.project_id ?? '';
            if (!projectId) {
                return {
                    ok: false,
                    error: `Workspace "${ws.project_name}" is not connected to a Tynn project, so there is nowhere to file feedback.`,
                };
            }
            try {
                const result = await backendOfKind(ws.backend === 'aionima' ? 'aionima' : 'tynn').submitFeedback(
                    projectId,
                    message,
                    {
                        genie_version: cfg.serverVersion,
                        workspace: ws.project_name,
                        ...(terminalId ? { terminal_id: terminalId } : {}),
                    },
                );
                return { ok: true, id: result.id };
            } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
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
