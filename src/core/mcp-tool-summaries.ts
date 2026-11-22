/**
 * AGENT MCP, THE TOOLS AS DATA (Tynn #718). Each builtin tool carries a WRITTEN one-line summary for the person (never a
 * cut of the model-facing description, which is for the model) and a family. A tool no table names — a plugin's, a GApp's —
 * is in `apps`, and its summary is the description's first whole sentence.
 */
export type McpToolFamily = 'attention' | 'messaging' | 'workspace' | 'apps';

export interface McpToolRow {
    readonly name: string;
    /** The full agent-facing text; shown only when a row is opened. */
    readonly description: string;
    readonly summary: string;
    readonly family: McpToolFamily;
    /**
     * Served only to SOME agents: a per-request gate decides (workspaceTabs and pages: the default agent, or one whose
     * switch is on). Genie's written instructions name only the tools every agent has (Tynn #1015). Absent = every agent.
     */
    readonly someAgents?: true;
}

export const MCP_FAMILIES: readonly { readonly id: McpToolFamily; readonly label: string; readonly icon: string }[] = [
    { id: 'attention', label: 'Attention', icon: 'bell' },
    { id: 'messaging', label: 'Messaging', icon: 'mail' },
    { id: 'workspace', label: 'Workspace', icon: 'folder' },
    { id: 'apps', label: 'Apps', icon: 'puzzle' },
];

/** Every builtin tool: its family and the line a person reads. */
export const BUILTIN_TOOL_SUMMARIES: Readonly<Record<string, { readonly family: Exclude<McpToolFamily, 'apps'>; readonly summary: string }>> = {
    imDone: { family: 'attention', summary: 'Hand back finished work with what is left.' },
    ForceTheQuestion: { family: 'attention', summary: 'Ask the person a decision only they can make.' },
    thumbsUp: { family: 'attention', summary: 'Quietly say that work landed well.' },
    openFileForUser: { family: 'attention', summary: 'Open a file for the person in their file panel.' },
    plan: { family: 'attention', summary: 'Show and update the agent’s step-by-step plan.' },
    agentinbox: { family: 'messaging', summary: 'Find other agents, message them, read replies.' },
    mail: { family: 'messaging', summary: 'Read and send email through the workspace mailbox.' },
    createAgent: { family: 'messaging', summary: 'Start a new agent in a workspace.' },
    knowledge: { family: 'workspace', summary: 'Read and record notes that outlast a session.' },
    lists: { family: 'workspace', summary: 'Keep lists the person can see and tick off.' },
    checkIssues: { family: 'workspace', summary: 'Check the workspace’s open issues.' },
    manageTerminals: { family: 'workspace', summary: 'Open, read and close terminals.' },
    services: { family: 'workspace', summary: 'Run databases, caches and mail for the workspace.' },
    sites: { family: 'workspace', summary: 'Serve, open and inspect the workspace’s sites.' },
    processes: { family: 'workspace', summary: 'Keep background processes running and read their logs.' },
    flows: { family: 'workspace', summary: 'List, run and inspect the workspace’s flows.' },
    workspaceTabs: { family: 'workspace', summary: 'Arrange the workspace’s tabs and panels.' },
    pages: { family: 'workspace', summary: 'Create and edit the workspace’s pages.' },
    playwright: { family: 'workspace', summary: 'See Genie’s Playwright browsers and ask for a version.' },
};

export function toolFamily(name: string): McpToolFamily {
    return BUILTIN_TOOL_SUMMARIES[name]?.family ?? 'apps';
}

function firstSentence(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    const m = /^.*?[.!?](?=\s|$)/.exec(flat);
    return m ? m[0] : flat;
}

export function toolSummary(name: string, description: string): string {
    return BUILTIN_TOOL_SUMMARIES[name]?.summary ?? firstSentence(description);
}

export function describeMcpTool(name: string, description: string, someAgents = false): McpToolRow {
    return { name, description, summary: toolSummary(name, description), family: toolFamily(name), ...(someAgents ? { someAgents: true as const } : {}) };
}

export function filterMcpTools(tools: readonly McpToolRow[], query: string): McpToolRow[] {
    const q = query.trim().toLowerCase();
    if (q === '') return [...tools];
    return tools.filter((t) => `${t.name}\n${t.summary}\n${t.description}`.toLowerCase().includes(q));
}

export function groupMcpTools(tools: readonly McpToolRow[]): { family: McpToolFamily; label: string; icon: string; tools: McpToolRow[] }[] {
    return MCP_FAMILIES
        .map((f) => ({ family: f.id, label: f.label, icon: f.icon, tools: tools.filter((t) => t.family === f.id) }))
        .filter((g) => g.tools.length > 0);
}
