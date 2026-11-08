import type { JsonObject, McpToolResult } from '@particle-academy/prism-mcp';
import { callerFrom } from './mcp-callers.js';
import { HOST_NATIVE_TOOLS, runsInWindow, type ForwardedToolCall } from './mcp-host-tools.js';
import type { Caller, Registration, ToolContext } from './mcp-tools.js';

/**
 * THE WINDOW'S SIDE OF GENIE'S TOOLS WHEN GENIE-HOST SERVES THEM (the host split, P3.1: plan §11d).
 *
 * genie-host serves Genie's MCP server. Its own tools (the stores and the sessions) run there; every other tool's call
 * is forwarded to this window, which runs today's handler (`windowToolRunner`). Inside the window, a flow's step that
 * calls one of the host's tools is sent to the host with the caller this window resolved (`withHostTools`) — the stores
 * those tools write are the host's, never this window's.
 */

/** A store the host owns, where the window must never reach it: any use says so instead of acting on nothing. */
export function hostOnly<T extends object>(what: string): T {
    return new Proxy({}, {
        get: (_target, key) => {
            if (key === 'then') return undefined; // not a promise
            throw new Error(`${what} is genie-host's (the host split, P3.1); ${String(key)} was asked of it in the window`);
        },
    }) as T;
}

/**
 * The registrations with the host's own tools replaced by calls to the host, carrying the caller resolved here. A host
 * tool's window action (`sites open`, `services exec`) runs here: the host would only forward it back.
 */
export function withHostTools(all: readonly Registration[], host: { runHostTool(call: ForwardedToolCall): Promise<McpToolResult> }, resolveCaller: (id: string) => Caller | null): Registration[] {
    return all.map((r) => {
        if (!HOST_NATIVE_TOOLS.has(r.definition.name)) return r;
        const handler = async (args: JsonObject, context: ToolContext): Promise<McpToolResult> => {
            if (runsInWindow(r.definition.name, args)) return r.handler(args, context);
            const resolved = callerFrom(args, context.headers, resolveCaller);
            if (typeof resolved === 'string') return { text: resolved, isError: true };
            return host.runHostTool({ name: r.definition.name, args, headers: { ...context.headers }, caller: resolved });
        };
        return { ...r, handler };
    });
}

/**
 * A forwarded call, run here: the caller the host resolved is vouched for under the id the call names (its session key
 * or terminal id), so today's handler finds it the way it always has. Only tools this window has; a host tool is refused,
 * except its window actions.
 */
export function windowToolRunner(registrations: () => readonly Registration[], vouched: Map<string, Caller>): (call: ForwardedToolCall) => Promise<McpToolResult> {
    return async (call) => {
        if (!runsInWindow(call.name, call.args)) return { text: `${call.name} is genie-host's own tool, not the window's`, isError: true };
        const r = registrations().find((x) => x.definition.name === call.name);
        if (!r) return { text: `${call.name} is not a tool this Genie window has`, isError: true };
        const id = call.headers['genie-session'] ?? (typeof call.args.terminalId === 'string' ? call.args.terminalId : call.headers.terminalid);
        if (call.caller && id) vouched.set(id, call.caller);
        return r.handler(call.args, { server: 'genie', tool: call.name, headers: { ...call.headers }, ...(call.callId ? { forwardedCallId: call.callId } : {}) });
    };
}
