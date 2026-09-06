/**
 * `manageFlows`, bound to the live host.
 *
 * `mcp.ts` is the decision — pure, injected, testable without Electron or a
 * database. This is the four-line binding, kept separate for the reason every
 * `*ForMcp` in this codebase is: the rules about what an agent may author are
 * worth testing on their own, and a function that reaches for the singleton
 * database cannot be.
 *
 * ## Scope comes from the CALLER
 *
 * The workspace a flow belongs to is resolved from the caller's terminal, never
 * from the arguments. A graph is data an agent wrote; a `scope` in the payload
 * is a suggestion from the thing being scoped. `bridge.ts` states the same rule
 * for windows, `executors.ts` for flow runs, and it is the same rule here.
 */

import { getDb } from '../db';
import { getAppGrant } from '../db';
import { callerWorkspaceIdFor } from '../mcp/caller-workspace';
import type { AppGrant } from '../apps/bridge-decision';
import { handleManageFlows } from './mcp';
import { agentPulse } from '../terminal/agent-pulse';

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

export async function manageFlowsForMcp(
    args: Record<string, unknown>,
    terminalId: string,
): Promise<unknown> {
    // Imported lazily: `flows/index.ts` reaches the bridge, which reaches the
    // MCP protocol, which reaches host-tools — and this module is loaded from
    // the host's server-deps, which host-tools is upstream of. A top-level
    // import would close that loop at module-evaluation time.
    const { runFlowByHand } = await import('./index');

    return handleManageFlows(args, {
        db: getDb(),
        workspaceId: () => callerWorkspaceIdFor(terminalId),
        loadGrant: grantFor,
        // The flow system holds the deps it was STARTED with. Building a second
        // set here would mean two answers to what a tool call can reach.
        run: (flowId) => runFlowByHand(flowId),
        // The green `!` — an AGENT ran a flow by hand. Bound here rather than
        // inside `runFlowByHand`, which a person's click in the Flow Manager also
        // goes through; this marker is about agent behaviour, and marking in the
        // shared runner would light the row for the user's own action.
        markRan: (workspaceId) => agentPulse.mark(workspaceId, 'flow-run'),
    });
}
