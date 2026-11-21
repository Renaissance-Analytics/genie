import type { JsonObject, McpToolResult } from '@particle-academy/prism-mcp';
import { builtinToolDefinition, declareBuiltinTool, type BuiltinTool } from './builtin-tool.js';
import { isAcpProvider } from '../core/engine.js';
import type { AgentRecord } from '../core/identity.js';
import { callerFrom } from './mcp-callers.js';
import type { Caller, McpCall, Registration } from './mcp-tools.js';

/**
 * `createAgent` — ANY AGENT MAY ASK TO CREATE A WORKSPACE AGENT; THE PERSON DECIDES (the owner, 2026-10-19, FTQ q_09d1f4a0:
 * "an agent can ask to create a new agent in its workspace … That request waits in the Deck until you approve it").
 *
 * In EVERY agent's tool list (Tynn #1015, 2026-11-21). It used to be shown only to a workspace's recorded default agent,
 * and the owner's beachhead — the only agent of its workspace, whose default had never been recorded — had no
 * createAgent while Genie's instructions promised it. The gate was always the person: the call waits for them (the
 * approval queue never auto-approves `agents.create`, whatever the agent's autonomy), then registers the agent in the
 * caller's workspace and answers with its AgentInbox address. A caller Genie does not know is refused (callerFrom).
 */

export const CREATE_AGENT_ACTION = 'agents.create';

export interface AgentToolsDeps {
    /** A caller's session key (or terminal id) → the caller; `null` for one Genie does not know. */
    readonly resolveCaller: (key: string) => Caller | null;
    readonly roster: () => readonly AgentRecord[];
    readonly approve: (caller: Caller, action: typeof CREATE_AGENT_ACTION, detail: string, call: McpCall | undefined) => Promise<'allowed' | 'denied'>;
    readonly register: (input: { workspaceId: string; provider: AgentRecord['provider']; name: string; instructions?: string | null }) => Promise<AgentRecord>;
    readonly addressOf: (record: AgentRecord) => string;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

/** An agent name: lower-case letters, digits and dashes, starting with a letter (the roster's own shape). */
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function agentTools(deps: AgentToolsDeps): Registration[] {
    const createAgent: Registration = {
        definition: builtinToolDefinition(CREATE_AGENT_TOOL),
        // No `visible`: every agent has it. A per-request gate read only the session header, so a Take Over terminal's
        // agent (known by its terminalId) could never have seen it either.
        handler: async (args: JsonObject, context) => {
            const found = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof found === 'string') return err(found);
            const name = typeof args.name === 'string' ? args.name.trim() : '';
            const provider = typeof args.provider === 'string' ? args.provider : '';
            const instructions = typeof args.instructions === 'string' && args.instructions.trim() !== '' ? args.instructions.trim() : null;
            if (!NAME.test(name)) return err('name is lower-case letters, digits and dashes, starting with a letter');
            if (!isAcpProvider(provider)) return err('provider is claude or codex');
            if (deps.roster().some((a) => a.workspaceId === found.workspaceId && a.name === name)) return err(`${found.workspaceId} already has an agent named ${name}`);
            const detail = `Create a new agent “${name}” (${provider}) in ${found.workspaceId}${instructions ? ` — instructions: ${instructions}` : ''}`;
            if ((await deps.approve(found, CREATE_AGENT_ACTION, detail, context)) !== 'allowed') return err('The person declined: no agent was created.');
            const record = await deps.register({ workspaceId: found.workspaceId, provider, name, instructions });
            return ok({ ok: true, id: record.id, name: record.name, address: deps.addressOf(record) });
        },
    };
    return [createAgent];
}


// ---------------------------------------------------------------- compiled declarations (ADF A2, Tynn #446)
// What these tools ARE, as data: the catalog registers them (main/genie-catalog.ts); the factory above binds handlers.
export const CREATE_AGENT_TOOL: BuiltinTool = declareBuiltinTool(
    'createAgent',
    'Ask the person to create a new agent in your workspace: its name, the provider it runs on, and its instructions. The person approves or declines in the Deck; nothing is created until they approve.',
    {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Lower-case letters, digits and dashes, e.g. "reviewer".' },
            provider: { type: 'string', enum: ['claude', 'codex'] },
            instructions: { type: 'string', description: 'What the new agent is for, in a sentence or two.' },
        },
        required: ['name', 'provider'],
    },
    'Create agent'
);
/** This module's tools, in the order its factory returns them. */
export const AGENT_TOOLS: readonly BuiltinTool[] = [CREATE_AGENT_TOOL];
