import { GENIE_MANAGED_MCP } from './mcp-missing.js';

/** RED stand-in (Tynn #628, the MCP server switches). */
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

export const MCP_WORDS = { required: '', note: (_agent: string) => '', saved: (_agent: string) => '', stays: (_name: string) => '', name: '' } as const;

export function mcpRows(_record: McpChoices): McpRow[] {
    return [];
}

export function mcpOffFor(_record: McpChoices): string[] {
    return [];
}

export function withMcpServer<T extends McpChoices>(record: T, _name: unknown, _on: unknown): { ok: true; record: T } | { ok: false; reason: string } {
    return { ok: true, record };
}

export function withMcpSeen<T extends McpChoices>(_record: T, _names: readonly string[]): T | null {
    return null;
}
