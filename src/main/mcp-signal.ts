import { isGenieAction } from '../core/agent-signals.js';
import { callerFrom } from './mcp-callers.js';
import type { Registration } from './mcp-tools.js';

/**
 * EVERY GENIE TOOL CALL SIGNALS ITS AGENT'S ROW (genie#1209). Each registration's handler is wrapped ONCE, where all of
 * them are gathered: a call that SUCCEEDED, made by an agent Genie knows, is reported as `done` (imDone) or `genie` (any
 * tool that acts, core/agent-signals.ts). The tool's answer, definition and visibility are untouched; a failed call, a
 * talking tool and an unknown caller report nothing.
 */
export function withActionSignal(
    registrations: readonly Registration[],
    resolve: (session: string) => { readonly agentId: string } | null,
    signal: (agentId: string, kind: 'done' | 'genie', tool: string) => void,
): Registration[] {
    return registrations.map((r) => {
        const name = r.definition.name;
        const kind = name === 'imDone' ? 'done' : isGenieAction(name) ? 'genie' : null;
        if (kind === null) return r;
        return {
            ...r,
            handler: async (args, context) => {
                const result = await r.handler(args, context);
                if (result.isError !== true) {
                    const caller = callerFrom(args, context.headers ?? {}, resolve);
                    if (typeof caller !== 'string') signal(caller.agentId, kind, name);
                }
                return result;
            },
        };
    });
}
