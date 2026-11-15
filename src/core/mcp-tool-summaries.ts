export type McpToolFamily = 'attention' | 'messaging' | 'workspace' | 'apps';
export interface McpToolRow { readonly name: string; readonly description: string; readonly summary: string; readonly family: McpToolFamily }
export const MCP_FAMILIES: readonly { readonly id: McpToolFamily; readonly label: string; readonly icon: string }[] = [];
export function toolFamily(_name: string): McpToolFamily { return 'apps'; }
export function toolSummary(_name: string, description: string): string { return description; }
export function describeMcpTool(name: string, description: string): McpToolRow { return { name, description, summary: description, family: 'apps' }; }
export function filterMcpTools(tools: readonly McpToolRow[], _query: string): McpToolRow[] { return [...tools]; }
export function groupMcpTools(_tools: readonly McpToolRow[]): { family: McpToolFamily; label: string; icon: string; tools: McpToolRow[] }[] { return []; }
