import { GENIE_MANAGED_MCP } from './mcp-missing.js';

/**
 * AN AGENT'S MCP SERVERS, SWITCHED ON AND OFF (Tynn #628; the owner, beta.61: "I need the ability to enable and disable
 * mcp … an agent can use"). Per agent, on its record:
 *
 * - `mcpOff`: the servers switched off, by name. Handed to the provider as disabled when the agent's next session starts
 *   (main/session-host.ts mcpPolicyOptions; prism-acp's `disabledMcpServers`, for Claude Code and for Codex).
 * - `mcpSeen`: every server one of its sessions reported, so the list is there while the agent is not running.
 *
 * WHAT CAN BE LISTED: Genie's own servers, and what a session reported. Neither provider documents a way to ask, before a
 * session, which servers it would load, so a server no session has reported yet is not listed and the page says so.
 * A server switched off stays listed (it is in `mcpOff`), so it can be switched back on.
 *
 * Genie's own servers (core/mcp-missing.ts GENIE_MANAGED_MCP) are required: never switched off, whatever a record holds.
 */
export const REQUIRED_MCP: readonly string[] = GENIE_MANAGED_MCP;

export interface McpRow {
    readonly name: string;
    readonly required: boolean;
    readonly on: boolean;
}

export interface McpChoices {
    readonly mcpOff?: readonly string[] | undefined;
    readonly mcpSeen?: readonly string[] | undefined;
}

export const MCP_WORDS = {
    required: 'Required by Genie',
    note: (agent: string) => `This list is Genie’s own servers and every server one of ${agent}’s sessions reported when it started. A server that no session has reported yet is not listed, and cannot be switched off here until it is.`,
    saved: (agent: string) => `Saved. It applies the next time ${agent} starts a session.`,
    stays: (name: string) => `${name} is Genie’s own server and stays on.`,
    name: 'Name the MCP server, and say on or off.',
} as const;

const NAME_LIMIT = 200;
/** A server's name as a provider reports it: one line of text, not empty, not absurdly long. */
function isName(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '' && value.length <= NAME_LIMIT && !/[\u0000-\u001f\u007f]/.test(value);
}

const names = (list: readonly string[] | undefined): string[] => [...new Set((list ?? []).filter(isName))].sort((a, b) => a.localeCompare(b));

/** The servers switched off for this agent: its record's, without Genie's own, each once, in order. */
export function mcpOffFor(record: McpChoices): string[] {
    return names(record.mcpOff).filter((name) => !REQUIRED_MCP.includes(name));
}

/** The page's rows: Genie's own first (required), then every server seen or switched off, by name. */
export function mcpRows(record: McpChoices): McpRow[] {
    const off = new Set(mcpOffFor(record));
    const others = names([...(record.mcpSeen ?? []), ...off]).filter((name) => !REQUIRED_MCP.includes(name));
    return [
        ...REQUIRED_MCP.map((name) => ({ name, required: true, on: true })),
        ...others.map((name) => ({ name, required: false, on: !off.has(name) })),
    ];
}

/** One server switched on or off. Genie's own is refused in words; so is anything that is not a name and an on or off. */
export function withMcpServer<T extends McpChoices>(record: T, name: unknown, on: unknown): { ok: true; record: T } | { ok: false; reason: string } {
    if (!isName(name) || typeof on !== 'boolean') return { ok: false, reason: MCP_WORDS.name };
    if (REQUIRED_MCP.includes(name)) return { ok: false, reason: MCP_WORDS.stays(name) };
    const off = mcpOffFor(record).filter((n) => n !== name);
    return { ok: true, record: { ...record, mcpOff: on ? off : names([...off, name]) } };
}

/** What a session reported, added to what was seen. `null` when it adds nothing, so nothing is written. */
export function withMcpSeen<T extends McpChoices>(record: T, reported: readonly string[]): T | null {
    const before = names(record.mcpSeen);
    const after = names([...before, ...reported]);
    return after.length === before.length ? null : { ...record, mcpSeen: after };
}
