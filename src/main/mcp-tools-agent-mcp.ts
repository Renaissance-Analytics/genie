import type { JsonObject, McpToolResult } from '@particle-academy/prism-mcp';
import { mcpRows } from '../core/agent-mcp.js';
import { appMcpAddress, parseAppMcpEntry, withAppMcp, withoutAppMcp, type AppMcpCandidate, type AppMcpEntry, type AppSite } from '../core/app-mcp.js';
import type { AgentRecord } from '../core/identity.js';
import { builtinToolDefinition, declareBuiltinTool, type BuiltinTool } from './builtin-tool.js';
import { callerFrom } from './mcp-callers.js';
import type { Caller, McpCall, Registration } from './mcp-tools.js';

/**
 * `agentMcp` — THE WORKSPACE'S DEFAULT AGENT MANAGES THE MCP SERVERS OF THE OTHER AGENTS THERE (Tynn #1033; the owner,
 * 2026-11-22: "workspace default agents need to be able to edit the mcp config for any of the other agents they spawn").
 *
 * - WHO: the workspace's default agent alone sees it (`visible`) and may call it (the handler checks again), and only on
 *   ANOTHER agent of its own workspace. A record does not say which agent created another, so "the agents it spawns" is
 *   read as the agents of the workspace it is the default of — the ones createAgent made there, and the rest.
 * - WHAT: `list` (its app servers, its switches, what the workspace offers), `add` an app MCP server (a site of the
 *   workspace, or a loopback URL: core/app-mcp.ts, local only and no secrets), `remove` one, switch any of its servers
 *   `on` or `off` (core/agent-mcp.ts, the same switches as its settings).
 * - THE PERSON DECIDES what gives an agent more: an add, and a server switched on, wait in the Deck (`agents.mcp`, never
 *   auto-approved, as createAgent: approval-queue.ts PERSON_ONLY_ACTIONS). A remove or an off takes away, and does not.
 * - WHY: every change names it, and it is said in the Deck and in the answer; the durable audit trail is #1004's.
 * - WHEN: at that agent's next session start, as a change in its settings; nothing restarts here.
 *
 * The writes go through the host's own `agents.setAppMcp` and `agents.setMcpServer`, the same path as the agent's settings.
 */

export const AGENT_MCP_ACTION = 'agents.mcp';

export const AGENT_MCP_WORDS = {
    defaultOnly: 'Only this workspace’s default agent manages the MCP servers of its other agents.',
    notItself: 'This is for the other agents of your workspace; the person manages your own MCP servers in your settings.',
    noAgent: (name: string) => `Your workspace has no agent “${name}”; \`agentinbox list\` shows them.`,
    why: 'Say why (`why`): it is shown to the person and kept with the change.',
    action: 'action is one of list, add, remove, on, off.',
    name: 'Name the server (`name`); `list` shows its servers.',
    declined: 'The person declined: its MCP servers are as they were.',
    applies: (agent: string) => `It applies the next time ${agent} starts a session.`,
} as const;

export interface AgentMcpToolDeps {
    /** A caller's session key (or terminal id) → the caller; `null` for one Genie does not know. */
    readonly resolveCaller: (key: string) => Caller | null;
    readonly roster: () => readonly AgentRecord[];
    readonly defaultAgentOf: (workspaceId: string) => string | null;
    readonly approve: (caller: Caller, action: typeof AGENT_MCP_ACTION, detail: string, call: McpCall | undefined) => Promise<'allowed' | 'denied'>;
    /** The workspace's Genie sites (what an add's `site` names). */
    readonly sites: (workspaceId: string) => readonly AppSite[];
    /** What the workspace offers to add, for this agent (core/app-mcp.ts appMcpCandidates). */
    readonly candidates: (workspaceId: string, record: AgentRecord) => readonly AppMcpCandidate[];
    readonly workspaceMcpOff: (workspaceId: string) => readonly string[];
    /** The host's `agents.setAppMcp`'s write: the checked list onto the record. */
    readonly setAppMcp: (agentId: string, list: readonly AppMcpEntry[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The host's `agents.setMcpServer`: one switch on its record. */
    readonly setMcpServer: (agentId: string, name: string, on: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

const ok = (payload: Record<string, unknown>): McpToolResult => ({ text: JSON.stringify({ ok: true, ...payload }), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const ACTIONS = ['list', 'add', 'remove', 'on', 'off'] as const;
/** The tool's own arguments; everything else an `add` names is the server, and is checked as one. */
const OWN_ARGS = new Set(['action', 'agent', 'why', 'terminalId']);

export function agentMcpTools(deps: AgentMcpToolDeps): Registration[] {
    const isDefault = (caller: Caller | null): boolean => caller !== null && deps.defaultAgentOf(caller.workspaceId) === caller.agentId;

    const tool: Registration = {
        definition: builtinToolDefinition(AGENT_MCP_TOOL),
        visible: ({ headers }) => {
            const key = headers['mcp-param-genie-session'] ?? headers['genie-session'];
            return typeof key === 'string' && isDefault(deps.resolveCaller(key));
        },
        handler: async (args: JsonObject, context) => {
            const caller = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof caller === 'string') return err(caller);
            // The handler's own check: never trusting that only the right caller can reach it.
            if (!isDefault(caller)) return err(AGENT_MCP_WORDS.defaultOnly);
            const action = str(args.action) ?? '';
            if (!(ACTIONS as readonly string[]).includes(action)) return err(AGENT_MCP_WORDS.action);
            const name = str(args.agent) ?? '';
            const target = deps.roster().find((a) => a.workspaceId === caller.workspaceId && (a.name === name || a.id === name));
            if (!target) return err(AGENT_MCP_WORDS.noAgent(name));
            if (target.id === caller.agentId) return err(AGENT_MCP_WORDS.notItself);
            const ws = caller.workspaceId;
            const sites = deps.sites(ws);

            if (action === 'list') {
                return ok({
                    agent: target.name,
                    appMcp: (target.appMcp ?? []).map((e) => ({ ...e, address: appMcpAddress(e, sites) })),
                    servers: mcpRows(target, deps.workspaceMcpOff(ws)).map((r) => ({ name: r.name, on: r.on, ...(r.required ? { required: true } : {}) })),
                    candidates: deps.candidates(ws, target),
                    note: AGENT_MCP_WORDS.applies(target.name),
                });
            }

            const why = str(args.why);
            if (why === undefined) return err(AGENT_MCP_WORDS.why);

            if (action === 'add') {
                const input = Object.fromEntries(Object.entries(args).filter(([key]) => !OWN_ARGS.has(key)));
                const parsed = parseAppMcpEntry(input, sites);
                if (!parsed.ok) return err(parsed.reason);
                const next = withAppMcp(target.appMcp, parsed.entry);
                if (!next.ok) return err(next.reason);
                const detail = `Give ${target.name} the MCP server “${parsed.entry.name}” (${appMcpAddress(parsed.entry, sites)}) — why: ${why}`;
                if ((await deps.approve(caller, AGENT_MCP_ACTION, detail, context)) !== 'allowed') return err(AGENT_MCP_WORDS.declined);
                const wrote = await deps.setAppMcp(target.id, next.list);
                if (!wrote.ok) return err(wrote.reason);
                return ok({ agent: target.name, added: parsed.entry.name, address: appMcpAddress(parsed.entry, sites), why, applies: AGENT_MCP_WORDS.applies(target.name) });
            }

            const server = str(args.name);
            if (server === undefined) return err(AGENT_MCP_WORDS.name);

            if (action === 'remove') {
                const next = withoutAppMcp(target.appMcp, server);
                if (!next.ok) return err(next.reason);
                const wrote = await deps.setAppMcp(target.id, next.list);
                if (!wrote.ok) return err(wrote.reason);
                return ok({ agent: target.name, removed: server, why, applies: AGENT_MCP_WORDS.applies(target.name) });
            }

            const on = action === 'on';
            if (on) {
                const detail = `Switch the MCP server “${server}” on for ${target.name} — why: ${why}`;
                if ((await deps.approve(caller, AGENT_MCP_ACTION, detail, context)) !== 'allowed') return err(AGENT_MCP_WORDS.declined);
            }
            const switched = await deps.setMcpServer(target.id, server, on);
            if (!switched.ok) return err(switched.reason);
            return ok({ agent: target.name, switched: server, on, why, applies: AGENT_MCP_WORDS.applies(target.name) });
        },
    };
    return [tool];
}

// ---------------------------------------------------------------- compiled declarations (ADF A2, Tynn #446)
// What this tool IS, as data: the catalog registers it (main/genie-catalog.ts); the factory above binds its handler.
export const AGENT_MCP_TOOL: BuiltinTool = declareBuiltinTool(
    'agentMcp',
    'Manage the MCP servers of another agent in your workspace (you are its default agent). `list {agent}` shows its app MCP servers, its switches, and what the workspace offers: each Genie site’s /mcp and each background process with a port. `add {agent, site, path?, name?, why}` or `add {agent, url, name?, why}` gives it an MCP server one of your apps serves (local addresses only, no keys); `remove {agent, name, why}`; `on`/`off {agent, name, why}` switches any of its servers. An add or an on waits for the person’s approval in the Deck. Each change applies at that agent’s next session start.',
    {
        type: 'object',
        properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            agent: { type: 'string', description: 'The agent’s name in your workspace.' },
            site: { type: 'string', description: 'add: one of the workspace’s sites (id, name or .gen host); `sites list` shows them.' },
            path: { type: 'string', description: 'add with site: the app’s MCP route, default /mcp.' },
            url: { type: 'string', description: 'add: a local MCP address, http://127.0.0.1:<port>/mcp (or localhost, or a site’s https://<name>.gen/…).' },
            name: { type: 'string', description: 'The server’s name: add (optional, from the site or port), remove, on, off.' },
            why: { type: 'string', description: 'Why: shown to the person and kept with the change. Needed for every change.' },
        },
        required: ['action', 'agent'],
    },
    'Agent MCP servers'
);
/** This module's tools, in the order its factory returns them. */
export const AGENT_MCP_TOOLS: readonly BuiltinTool[] = [AGENT_MCP_TOOL];
