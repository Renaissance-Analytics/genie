import { handleMcpMessage, type JsonRpcRequest, type McpContext } from '../mcp/protocol';
import type { DispatchFrame, ShuttleResponse } from './core';
import type { ShuttleManifest, ShuttlePrompt, ShuttleTool } from './manifest-store';

/**
 * GENIE'S SIDE OF THE SHUTTLE — what it publishes, and how it runs what it is sent.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §4.2, §4.3.
 *
 * The shuttle answers discovery from the manifest Genie publishes and forwards every
 * other request back to Genie. The property that matters is that an agent cannot
 * tell the shuttle from the in-process server. So neither half restates the
 * protocol: the manifest is built by ASKING `handleMcpMessage` for `initialize`,
 * `tools/list` and `prompts/list`, and a dispatched call runs through
 * `handleMcpMessage` exactly as a request on the in-process server does. A tool
 * added to `protocol.ts` reaches the shuttle with no second edit.
 *
 * Pure apart from the injected context: no socket, no process.
 */

export interface ManifestStamp {
    genieVersion: string;
    /** Monotonic per Genie boot. */
    generation: number;
}

/** A discovery request the in-process server answers without touching any tool. */
async function discover(ctx: McpContext, method: string): Promise<Record<string, unknown>> {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: method, method, params: {} }, ctx);
    if (!response || response.error || !response.result || typeof response.result !== 'object') {
        // Refuse to publish rather than publish a surface with a hole in it: the
        // shuttle keeps serving the last good manifest when this one never arrives.
        throw new Error(
            `Genie could not build its MCP manifest: ${method} answered ${JSON.stringify(response?.error ?? response)}`,
        );
    }
    return response.result as Record<string, unknown>;
}

/**
 * The surface the shuttle serves while this Genie is the publisher — exactly what
 * the in-process server would answer for the same context.
 */
export async function buildManifest(ctx: McpContext, stamp: ManifestStamp): Promise<ShuttleManifest> {
    const init = await discover(ctx, 'initialize');
    const tools = await discover(ctx, 'tools/list');
    const prompts = await discover(ctx, 'prompts/list');

    return {
        genieVersion: stamp.genieVersion,
        generation: stamp.generation,
        protocolVersions: [String(init.protocolVersion)],
        serverInfo: init.serverInfo as ShuttleManifest['serverInfo'],
        instructions: String(init.instructions ?? ''),
        capabilities: (init.capabilities ?? {}) as Record<string, unknown>,
        tools: tools.tools as ShuttleTool[],
        prompts: prompts.prompts as ShuttlePrompt[],
        // The in-process server declares no resources capability and answers
        // `resources/list` as unknown, so the shuttle's listener must too.
        resources: [],
    };
}

/**
 * Run one dispatched request for the terminal the shuttle resolved, and answer
 * with its result or error — never with a rejection.
 *
 * A rejection would leave the agent's call waiting in the shuttle until the
 * publisher disconnected: a hang that reads as a broken tool, which is the exact
 * misreading the shuttle exists to remove. So anything thrown becomes a JSON-RPC
 * internal error that names Genie.
 */
export async function runDispatch(
    frame: DispatchFrame,
    contextFor: (terminalId: string) => McpContext,
): Promise<ShuttleResponse> {
    try {
        const ctx = contextFor(frame.route?.terminalId ?? '');
        const response = await handleMcpMessage(frame.request as JsonRpcRequest, ctx);
        // The listener answers notifications itself and never forwards one, so a
        // null here means a request the protocol treated as a notification.
        if (!response) return { result: {} };
        if (response.error) return { error: response.error };
        return { result: response.result };
    } catch (e) {
        return {
            error: {
                code: -32603,
                message: `Genie failed while handling this call: ${e instanceof Error ? e.message : String(e)}`,
            },
        };
    }
}
