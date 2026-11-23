import type { McpToolResult } from '@particle-academy/prism-mcp';
import { runsInWindow, type ForwardedToolCall } from './mcp-host-tools.js';
import type { Caller, Registration } from './mcp-tools.js';

/**
 * THE WINDOW'S SIDE OF GENIE'S TOOLS WHEN GENIE-HOST SERVES THEM (the host split, P3.1: plan §11d).
 *
 * genie-host serves Genie's MCP server. Its own tools (the stores and the sessions) run there; every other tool's call
 * is forwarded to this window, which runs today's handler (`windowToolRunner`). Nothing in the window calls one of the
 * host's tools: a flow's steps run in genie-host, and the stores those tools write are the host's (Tynn #1043).
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
