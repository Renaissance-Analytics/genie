import type { JsonObject, McpToolResult } from '@particle-academy/prism-mcp';
import { callerFrom } from './mcp-callers.js';
import type { Caller, McpCall, Registration, ToolContext } from './mcp-tools.js';

/**
 * WHICH OF GENIE'S TOOLS RUN IN GENIE-HOST, AND WHAT THE REST DO (the host split, P3.1: plan §11d).
 *
 * Genie's MCP server lives in genie-host, so an agent keeps its tools when the window closes. The tools whose world is
 * the host's own — the stores agents write to and the sessions — run here. The others (sites, services, processes,
 * terminals, pages, workspace tabs, createAgent, checkIssues, the plugins' tools) still need what only the window has in
 * this phase, so their calls are FORWARDED to it whole, with the caller the host resolved; the window runs today's
 * handler. With no window the agent is told at once, in words; a window that closes mid-call answers the same way.
 */

/** The tools the host answers itself. Everything else is the window's (forwarded). */
// `processes` since P3.3c: the book, its scheduler and the supervisor are the host's.
export const HOST_NATIVE_TOOLS: ReadonlySet<string> = new Set(['agentinbox', 'ForceTheQuestion', 'imDone', 'lists', 'plan', 'knowledge', 'thumbsUp', 'processes']);

/** What the window is handed: the tool, its arguments and headers as the agent sent them, and who the host says is calling. */
export interface ForwardedToolCall {
    readonly name: string;
    readonly args: JsonObject;
    readonly headers: Readonly<Record<string, string>>;
    readonly caller: Caller | null;
    /** The call's id in the host while it is forwarded: the window's approval asks under it (genie#1360). */
    readonly callId?: string;
}

export interface HostToolsOptions {
    readonly resolveCaller: (id: string) => Caller | null;
    readonly window: {
        connected(): boolean;
        /** The window runs the tool; rejects when there is none, or when it closes before it answers. */
        call(call: ForwardedToolCall): Promise<McpToolResult>;
    };
    /** openFileForUser with no window: kept, and shown when the next window connects. */
    readonly openFileLater: (call: ForwardedToolCall) => void;
    /** The agent's calls while they are forwarded, by id: an approval the window's tool asks is tied to its call. */
    readonly forwardedCalls?: Map<string, McpCall>;
}

/** What a window tool answers when there is no window. The agent reads it; nothing was done. */
export function windowClosedRefusal(name: string): string {
    return `${name} runs in Genie's window, which is closed. Nothing was done. Ask the person to open Genie, then call ${name} again.`;
}

function windowLostRefusal(name: string, why: string): string {
    return `${name}: Genie's window closed before it answered (${why}), so it may or may not have been done — check before calling it again.`;
}

/** Every registration as the host serves it: the host's own tools as they are, every other one forwarded to the window. */
export function hostRegistrations(all: readonly Registration[], options: HostToolsOptions): Registration[] {
    let seq = 0;
    return all.map((r) => {
        const name = r.definition.name;
        if (HOST_NATIVE_TOOLS.has(name)) return r;
        const handler = async (args: JsonObject, context: ToolContext): Promise<McpToolResult> => {
            const resolved = callerFrom(args, context.headers, options.resolveCaller);
            const call: ForwardedToolCall = { name, args, headers: { ...context.headers }, caller: typeof resolved === 'string' ? null : resolved };
            if (!options.window.connected()) {
                if (name === 'openFileForUser') {
                    options.openFileLater(call);
                    return { text: "Genie's window is closed; the file opens when Genie is next opened.", isError: false };
                }
                return { text: windowClosedRefusal(name), isError: true };
            }
            const callId = `fwd-${++seq}`;
            options.forwardedCalls?.set(callId, { signal: context.signal, progress: context.progress });
            try {
                return await options.window.call({ ...call, callId });
            } catch (error) {
                return { text: windowLostRefusal(name, error instanceof Error ? error.message : String(error)), isError: true };
            } finally {
                options.forwardedCalls?.delete(callId);
            }
        };
        return { ...r, handler };
    });
}
