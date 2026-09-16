import { agentInboxBroker } from '../agentinbox/broker';
import { terminalsToStopFor } from '../agents/deletion';
import { requestHandoffBeforeStop } from '../agents/handoff-request';
import { getWorkspace, isWorkspaceHibernated, listWorkspaceAgents, setWorkspaceHibernated } from '../db';
import { devLifecycle } from '../dev-server/lifecycle';
import { isTerminalLive, stopWorkspaceTerminalsForHibernation } from '../terminal/ipc';
import { armWorkspaceSchedules, disarmWorkspaceSchedules } from '../terminal/process-scheduler';
import { startAutostartProcesses } from '../terminal/process-supervisor';
import type { HibernationDeps } from './hibernation';
import { SYSTEM_WORKSPACE_ROW_ID } from './system-workspace-id';

/**
 * HIBERNATION, WIRED (genie#672).
 *
 * `hibernation.ts` decides the order and the refusals, and each step's own module
 * is tested for what it does. This is only the wiring that hands those decisions
 * Genie's real database, terminals, scheduler, dev server and inbox — deliberately
 * thin, so nothing here is a judgement that a test cannot see.
 */
export function hibernationDeps(changed: () => void): HibernationDeps {
    return {
        workspace(id) {
            const row = getWorkspace(id);
            return row ? { id: row.id, name: row.project_name, path: row.path } : null;
        },
        isSystem: (id) => id === SYSTEM_WORKSPACE_ROW_ID,
        isHibernated: (id) => isWorkspaceHibernated(id),
        setHibernated: (id, on) => setWorkspaceHibernated(id, on),
        runningAgents(id) {
            return listWorkspaceAgents(id)
                .map((agent) => ({
                    name: agent.name,
                    // The same terminals the stop below kills, and only the live ones:
                    // asking a terminal that is not running wastes nothing but a wait.
                    terminalIds: terminalsToStopFor(agent).filter((t) => isTerminalLive(t)),
                }))
                .filter((agent) => agent.terminalIds.length > 0);
        },
        requestHandoff: (workspace, agent) =>
            requestHandoffBeforeStop({
                workspaceRoot: workspace.path,
                agentName: agent.name,
                terminalIds: agent.terminalIds,
                deliver: (terminalId, text) => agentInboxBroker.deliverHumanMessageToTerminal(terminalId, text),
            }),
        stopTerminals: async (id) => stopWorkspaceTerminalsForHibernation(id).length,
        disarmSchedules: (id) => disarmWorkspaceSchedules(id),
        async hibernateDevServer(id) {
            const lifecycle = devLifecycle();
            if (!lifecycle) return { errors: [] };
            const result = await lifecycle.onWorkspaceHibernate(id);
            return { errors: result.errors };
        },
        purgeAgentInbox: (id) => agentInboxBroker.purgeAgents(listWorkspaceAgents(id).map((a) => a.id)),
        async wakeDevServer(id) {
            await devLifecycle()?.onWorkspaceWake(id);
        },
        armSchedules: (id) => armWorkspaceSchedules(id),
        startProcesses: (id) => startAutostartProcesses(id),
        changed,
    };
}
