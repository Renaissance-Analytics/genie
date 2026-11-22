import type { JsonObject, McpToolResult } from '@particle-academy/prism-mcp';
import { builtinToolDefinition, declareBuiltinTool, type BuiltinTool } from './builtin-tool.js';
import { isAcpProvider, type AcpProvider } from '../core/engine.js';
import { agentRecord, type AgentId, type AgentRecord } from '../core/identity.js';
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
 *
 * A COMPLETE AGENT, as the UI's Add agent makes one (Tynn #1015): its `instructions` are its PURPOSE, written to the
 * workspace's project.json `agents.<name>` and to `.agents/<name>/AGENT.md`, then registered (genie-host's `addAgent`,
 * agent-create-host.ts). With no instructions there is no purpose: refused before the person is asked.
 */

export const CREATE_AGENT_ACTION = 'agents.create';

export type CreateOutcome = { ok: true; record: AgentRecord } | { ok: false; reason: string };

/** What the agent is told when it gave no instructions: an agent without a purpose is not made (Add agent's rule). */
export const NO_PURPOSE = 'give the agent a purpose: say in instructions what it is for, in a sentence or two. Nothing was asked or created.';

/**
 * createAgent's `create`, through genie-host's own Add agent (`addAgent`, host-api.ts: the form's path, agent-create-host.ts):
 * the record afterwards from the registry that registered it, or a stand-in with the id it answered when that registry has
 * not seen it yet (a window's replica a moment behind).
 */
export function createThroughAddAgent(invoke: (method: 'addAgent', args: unknown[]) => Promise<unknown>, find: (id: string) => AgentRecord | null): AgentToolsDeps['create'] {
    return async (input) => {
        const answer = (await invoke('addAgent', [input.workspaceId, { name: input.name, purpose: input.purpose, provider: input.provider }])) as { ok?: unknown; id?: unknown; reason?: unknown } | null;
        if (answer?.ok !== true || typeof answer.id !== 'string') return { ok: false, reason: typeof answer?.reason === 'string' ? answer.reason : 'the agent was not created' };
        return { ok: true, record: find(answer.id) ?? agentRecord({ id: answer.id as AgentId, workspaceId: input.workspaceId, provider: input.provider, name: input.name }) };
    };
}

export interface AgentToolsDeps {
    /** A caller's session key (or terminal id) → the caller; `null` for one Genie does not know. */
    readonly resolveCaller: (key: string) => Caller | null;
    readonly roster: () => readonly AgentRecord[];
    readonly approve: (caller: Caller, action: typeof CREATE_AGENT_ACTION, detail: string, call: McpCall | undefined) => Promise<'allowed' | 'denied'>;
    /** Make the agent as Add agent does (project.json + AGENT.md + the registry): the record, or the refusal in words. */
    readonly create: (input: { workspaceId: string; provider: AcpProvider; name: string; purpose: string }) => Promise<CreateOutcome>;
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
            if (instructions === null) return err(NO_PURPOSE);
            if (deps.roster().some((a) => a.workspaceId === found.workspaceId && a.name === name)) return err(`${found.workspaceId} already has an agent named ${name}`);
            const detail = `Create a new agent “${name}” (${provider}) in ${found.workspaceId}${instructions ? ` — instructions: ${instructions}` : ''}`;
            if ((await deps.approve(found, CREATE_AGENT_ACTION, detail, context)) !== 'allowed') return err('The person declined: no agent was created.');
            const made = await deps.create({ workspaceId: found.workspaceId, provider, name, purpose: instructions });
            if (!made.ok) return err(made.reason);
            return ok({ ok: true, id: made.record.id, name: made.record.name, address: deps.addressOf(made.record) });
        },
    };
    return [createAgent];
}


// ---------------------------------------------------------------- compiled declarations (ADF A2, Tynn #446)
// What these tools ARE, as data: the catalog registers them (main/genie-catalog.ts); the factory above binds handlers.
export const CREATE_AGENT_TOOL: BuiltinTool = declareBuiltinTool(
    'createAgent',
    'Ask the person to create a new agent in your workspace: its name, the provider it runs on, and its instructions (what it is for: written to its AGENT.md and the workspace’s project.json, as Add agent does). The person approves or declines in the Deck; nothing is created until they approve.',
    {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Lower-case letters, digits and dashes, e.g. "reviewer".' },
            provider: { type: 'string', enum: ['claude', 'codex'] },
            instructions: { type: 'string', description: 'What the new agent is for, in a sentence or two: its purpose.' },
        },
        required: ['name', 'provider', 'instructions'],
    },
    'Create agent'
);
/** This module's tools, in the order its factory returns them. */
export const AGENT_TOOLS: readonly BuiltinTool[] = [CREATE_AGENT_TOOL];
