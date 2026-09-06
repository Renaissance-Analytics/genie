/**
 * A user-scoped flow calling a Genie tool.
 *
 * A `gapp` flow calls through `dispatchAppCall` and is bounded by its app's
 * grant. A `system` or `workspace` flow has no app and no grant — it acts as the
 * USER — so it needs a way in of its own, and this is deliberately the *same*
 * way in: it builds a `tools/call` message and hands it to `handleMcpMessage`,
 * the one handler the agent path and the GApp path already share. There is no
 * second implementation of any tool.
 *
 * ## What bounds it, since there is no grant
 *
 * Three things, and they are not interchangeable:
 *
 *  1. **Admission**, before the first node runs. Every step names its tool
 *     structurally, so the whole graph is judged up front — and a step naming a
 *     tool no app could ever be granted is refused there, because an ungrantable
 *     tool has no node kind to resolve in the first place.
 *  2. **The caller identity.** The call presents as `flow:<id>`, and
 *     `resolveAgentTarget` reads the flow's SCOPE to decide where it may act. A
 *     workspace flow cannot reach another workspace even if a node asks.
 *  3. **Arming.** A flow is born disarmed and a person turns it on, against a
 *     graph they can read. That is the consent, and it is the reason a
 *     user-scoped flow may do user-scoped things at all.
 *
 * The tool name is re-checked here anyway. Admission is fail-fast and honest UX;
 * a gate that only runs once is a gate that eventually gets skipped, and this
 * one costs a map lookup.
 *
 * ## `terminalId` is overwritten, never taken
 *
 * `prepareAppToolCall` states the same rule for windows: the caller does not get
 * to choose who it is. A node's config is graph data, and a graph can be
 * hand-edited, so a `terminalId` in it would be a caller claiming to be an agent
 * in somebody's workspace.
 */

import { capabilityForTool } from '../apps/capabilities';
import { flowCallerId } from '../mcp/caller-identity';
import { handleMcpMessage } from '../mcp/protocol';
import type { ServerDeps } from '../mcp/server';
import type { FlowDispatchResult } from './executors';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

let nextId = 1;

export async function dispatchFlowCall(
    flowId: string,
    input: { tool: string; args: unknown; workspaceId: string | undefined },
    deps: ServerDeps,
): Promise<FlowDispatchResult> {
    // A tool no capability classifies is one nobody decided a flow may use.
    // Unclassified means denied, the same way `decideAppCall` reads it.
    if (!capabilityForTool(input.tool)) {
        return {
            ok: false,
            error: `Genie does not let a flow call “${input.tool}”.`,
        };
    }

    const args: Record<string, unknown> = isRecord(input.args) ? { ...input.args } : {};
    if (input.workspaceId !== undefined) args.workspaceId = input.workspaceId;
    delete args.terminalId;

    try {
        const response = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: nextId++,
                method: 'tools/call',
                params: { name: input.tool, arguments: args },
            },
            { ...flowMcpContext(deps, flowId) },
        );
        if (response && 'error' in response && response.error) {
            return { ok: false, error: response.error.message };
        }
        return { ok: true, result: response && 'result' in response ? response.result : undefined };
    } catch (e) {
        // A throwing tool must not take the main process down with it, and a
        // scheduled flow must not wedge on one.
        return { ok: false, error: e instanceof Error ? e.message : 'The call failed.' };
    }
}

/**
 * The MCP context a flow's calls run in.
 *
 * Identical to a GApp's but for the caller id — same deps, same handler, same
 * tools. Building it from `deps` rather than listing fields means a dep added
 * for agents reaches flows without anybody remembering to add it here.
 */
function flowMcpContext(deps: ServerDeps, flowId: string) {
    return { ...deps, terminalId: flowCallerId(flowId), serverName: 'genie' };
}
