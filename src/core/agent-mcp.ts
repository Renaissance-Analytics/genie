import { GENIE_MANAGED_MCP } from './mcp-missing.js';

/**
 * AN AGENT'S MCP SERVERS, SWITCHED ON AND OFF (Tynn #628; the owner, beta.61: "I need the ability to enable and disable
 * mcp … an agent can use"). Per agent, on its record:
 *
 * - `mcpOff`: the servers switched off for it, by name.
 * - `mcpOn`: the servers switched ON for it although its workspace has them off.
 * - `mcpSeen`: every server one of its sessions reported, so the list is there while the agent is not running.
 *
 * THE WORKSPACE'S DEFAULT: a workspace keeps its own `mcpOff`. An agent with no choice of its own for a server INHERITS
 * the workspace's; its own choice wins. A choice equal to the workspace's is not kept: the agent inherits again, so a
 * later change of the workspace's default reaches it.
 *
 * What is off for an agent is handed to its provider as disabled when its next session starts (main/session-host.ts
 * mcpPolicyOptions; prism-acp's `disabledMcpServers`, for Claude Code and for Codex).
 *
 * WHAT CAN BE LISTED: Genie's own servers, and what a session reported. Neither provider documents a way to ask, before a
 * session, which servers it would load, so a server no session has reported yet is not listed and the page says so.
 * A server switched off stays listed, so it can be switched back on.
 *
 * Genie's own servers (core/mcp-missing.ts GENIE_MANAGED_MCP) are required: never switched off, whatever a record holds.
 */
export const REQUIRED_MCP: readonly string[] = GENIE_MANAGED_MCP;

export interface McpRow {
    readonly name: string;
    readonly required: boolean;
    readonly on: boolean;
    /** An agent's row: it has no choice of its own, and its workspace has this server off. */
    readonly inherited?: boolean;
    /** An agent's row: it is on for this agent although its workspace has it off. */
    readonly overrides?: boolean;
}

export interface McpChoices {
    readonly mcpOff?: readonly string[] | undefined;
    readonly mcpOn?: readonly string[] | undefined;
    readonly mcpSeen?: readonly string[] | undefined;
}

export const MCP_WORDS = {
    required: 'Required by Genie',
    note: (agent: string) => `This list is Genie’s own servers and every server one of ${agent}’s sessions reported when it started. A server that no session has reported yet is not listed, and cannot be switched off here until it is.`,
    workspaceNote: 'The default for every agent in this workspace; an agent’s own switch wins. This list is Genie’s own servers and every server a session of one of this workspace’s agents reported. A server that no session has reported yet is not listed.',
    saved: (agent: string) => `Saved. It applies the next time ${agent} starts a session.`,
    workspaceSaved: 'Saved. It applies the next time each agent here starts a session.',
    inherited: 'Off, inherited from the workspace',
    overrides: 'On for this agent; the workspace has it off',
    stays: (name: string) => `${name} is Genie’s own server and stays on.`,
    name: 'Name the MCP server, and say on or off.',
} as const;

const NAME_LIMIT = 200;
/** A server's name as a provider reports it: one line of text, not empty, not absurdly long. */
function isName(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '' && value.length <= NAME_LIMIT && !/[\u0000-\u001f\u007f]/.test(value);
}

const names = (list: readonly string[] | undefined): string[] => [...new Set((list ?? []).filter(isName))].sort((a, b) => a.localeCompare(b));
const switchable = (list: readonly string[] | undefined): string[] => names(list).filter((name) => !REQUIRED_MCP.includes(name));

/** The servers off for this agent: its workspace's and its own, without the ones it switched on and without Genie's own. */
export function mcpOffFor(record: McpChoices, workspaceOff: readonly string[] = []): string[] {
    const on = new Set(switchable(record.mcpOn));
    const own = new Set(switchable(record.mcpOff));
    return switchable([...workspaceOff, ...own]).filter((name) => own.has(name) || !on.has(name));
}

/** An agent's rows: Genie's own first (required), then every server seen, switched, or off in its workspace, by name. */
export function mcpRows(record: McpChoices, workspaceOff: readonly string[] = []): McpRow[] {
    const off = new Set(mcpOffFor(record, workspaceOff));
    const own = new Set(switchable(record.mcpOff));
    const ownOn = new Set(switchable(record.mcpOn));
    const workspace = new Set(switchable(workspaceOff));
    const others = switchable([...(record.mcpSeen ?? []), ...own, ...ownOn, ...workspace]);
    return [
        ...REQUIRED_MCP.map((name) => ({ name, required: true, on: true })),
        ...others.map((name) => ({
            name, required: false, on: !off.has(name),
            ...(workspace.has(name) && !own.has(name) && !ownOn.has(name) ? { inherited: true } : {}),
            ...(workspace.has(name) && !own.has(name) && ownOn.has(name) ? { overrides: true } : {}),
        })),
    ];
}

/**
 * One server switched on or off for an agent. A choice equal to its workspace's default clears the agent's own, so it
 * inherits; any other is kept as its own. Genie's own is refused in words; so is anything that is not a name and an on or off.
 */
export function withMcpServer<T extends McpChoices>(record: T, name: unknown, on: unknown, workspaceOff: readonly string[] = []): { ok: true; record: T } | { ok: false; reason: string } {
    if (!isName(name) || typeof on !== 'boolean') return { ok: false, reason: MCP_WORDS.name };
    if (REQUIRED_MCP.includes(name)) return { ok: false, reason: MCP_WORDS.stays(name) };
    const offByDefault = switchable(workspaceOff).includes(name);
    const mcpOff = switchable(record.mcpOff).filter((n) => n !== name);
    const mcpOn = switchable(record.mcpOn).filter((n) => n !== name);
    if (on && offByDefault) mcpOn.push(name);
    if (!on && !offByDefault) mcpOff.push(name);
    return { ok: true, record: { ...record, mcpOff: names(mcpOff), mcpOn: names(mcpOn) } };
}

/** What a session reported, added to what was seen. `null` when it adds nothing, so nothing is written. */
export function withMcpSeen<T extends McpChoices>(record: T, reported: readonly string[]): T | null {
    const before = names(record.mcpSeen);
    const after = names([...before, ...reported]);
    return after.length === before.length ? null : { ...record, mcpSeen: after };
}

/** A workspace's rows: Genie's own (required), then every server one of its agents' sessions reported, or it has off. */
export function workspaceMcpRows(workspace: { readonly mcpOff?: readonly string[] | undefined; readonly mcpSeen?: readonly string[] | undefined }): McpRow[] {
    const off = new Set(switchable(workspace.mcpOff));
    return [
        ...REQUIRED_MCP.map((name) => ({ name, required: true, on: true })),
        ...switchable([...(workspace.mcpSeen ?? []), ...off]).map((name) => ({ name, required: false, on: !off.has(name) })),
    ];
}

/** One server switched on or off as a workspace's default: its new off list, or the refusal in words. */
export function withWorkspaceMcpServer(off: readonly string[] | undefined, name: unknown, on: unknown): { ok: true; mcpOff: string[] } | { ok: false; reason: string } {
    if (!isName(name) || typeof on !== 'boolean') return { ok: false, reason: MCP_WORDS.name };
    if (REQUIRED_MCP.includes(name)) return { ok: false, reason: MCP_WORDS.stays(name) };
    const rest = switchable(off).filter((n) => n !== name);
    return { ok: true, mcpOff: on ? rest : names([...rest, name]) };
}
