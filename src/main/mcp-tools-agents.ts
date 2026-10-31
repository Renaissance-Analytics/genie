import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import { isAcpProvider } from '../core/engine.js';
import type { AgentRecord } from '../core/identity.js';
import { callerFrom } from './mcp-callers.js';
import type { Caller, McpCall, Registration } from './mcp-tools.js';

/**
 * `createAgent` — THE DEFAULT AGENT MAY ASK TO CREATE A WORKSPACE AGENT (the owner, 2026-10-19, FTQ q_09d1f4a0: "an agent
 * can ask to create a new agent in its workspace … That request waits in the Deck until you approve it"; "If an agent is
 * not the default workspace agent then it cannot create new agents and shouldn't even have the tool in its catalog").
 *
 * Visible ONLY to the session of its workspace's default agent (prism-mcp-server 0.3.0's per-request `visible`): absent
 * from everyone else's tools/list, and refused to them exactly as an unknown tool is. The call waits for the PERSON — the
 * approval queue never auto-approves `agents.create`, whatever the agent's autonomy — then registers the agent in the
 * caller's workspace and answers with its AgentInbox address.
 */

export const CREATE_AGENT_ACTION = 'agents.create';

export interface AgentToolsDeps {
    /** A caller's session key (or terminal id) → the caller; `null` for one Genie does not know. */
    readonly resolveCaller: (key: string) => Caller | null;
    readonly defaultAgentOf: (workspaceId: string) => string | null;
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
    const isDefault = (caller: Caller | null): boolean => caller !== null && deps.defaultAgentOf(caller.workspaceId) === caller.agentId;
    const createAgent: Registration = {
        definition: new ToolDefinition(
            'createAgent',
            'Ask the person to create a new agent in your workspace: its name, the provider it runs on, and its instructions. The person approves or declines in the Deck; nothing is created until they approve. You have this because you are this workspace’s default agent.',
            {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Lower-case letters, digits and dashes, e.g. "reviewer".' },
                    provider: { type: 'string', enum: ['claude', 'codex'] },
                    instructions: { type: 'string', description: 'What the new agent is for, in a sentence or two.' },
                },
                required: ['name', 'provider'],
            },
            'Create agent',
        ),
        // Headers arrive lower-cased (prism-mcp-server 0.3.0), as the raw `Mcp-Param-Genie-Session` or its mirrored form.
        visible: ({ headers }) => {
            const key = headers['mcp-param-genie-session'] ?? headers['genie-session'];
            return typeof key === 'string' && isDefault(deps.resolveCaller(key));
        },
        handler: async (args: JsonObject, context) => {
            const found = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof found === 'string') return err(found);
            // The handler's own check — never trusting that only the right caller can reach it.
            if (!isDefault(found)) return err('Only this workspace’s default agent can ask to create an agent.');
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
