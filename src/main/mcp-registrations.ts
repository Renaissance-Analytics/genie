import { genieTools, type GenieToolsDeps, type Registration } from './mcp-tools.js';
import { attentionTools, type AttentionToolsDeps } from './mcp-tools-attention.js';
import { hostingTools, type HostingToolsDeps } from './mcp-tools-hosting.js';
import { moreGenieTools, type MoreToolsDeps } from './mcp-tools-more.js';
import { agentTools, type AgentToolsDeps } from './mcp-tools-agents.js';
import { pluginTools, type PluginToolsDeps } from './mcp-tools-plugins.js';
import { processTools, type ProcessToolsDeps } from './mcp-tools-processes.js';
import { flowTools, type FlowToolsDeps } from './mcp-tools-flows.js';
import { workspaceTabsTools, type WorkspaceTabsToolDeps } from './mcp-tools-workspace-tabs.js';
import { pagesTools, type PagesToolDeps } from './mcp-tools-pages.js';

/**
 * EVERY GENIE TOOL, ONCE (§6.9). The six tool modules compose into the one list the server registers:
 * the Genie tools in a stable order, then every enabled plugin's tools under their plugin's namespace.
 * Names are unique or `Server.register` refuses — so this is also where a collision would surface.
 */

export interface AllToolsDeps {
    readonly genie: GenieToolsDeps;
    readonly more: MoreToolsDeps;
    readonly attention: AttentionToolsDeps;
    readonly hosting: HostingToolsDeps;
    readonly processes: ProcessToolsDeps;
    readonly flows: FlowToolsDeps;
    readonly plugins: PluginToolsDeps;
    /** `createAgent`, visible to a workspace's default agent only (mcp-tools-agents.ts). Absent = not registered (doctor mode). */
    readonly agents?: AgentToolsDeps;
    /** `workspaceTabs`, visible to the default agent and agents allowed to manage tabs (mcp-tools-workspace-tabs.ts). Absent = not registered (doctor mode). */
    readonly workspaceTabs?: WorkspaceTabsToolDeps;
    /** `pages`, visible to the default agent and agents allowed to drive pages (mcp-tools-pages.ts). Absent = not registered (doctor mode). */
    readonly pages?: PagesToolDeps;
}

export function allGenieTools(deps: AllToolsDeps): Registration[] {
    return [...genieTools(deps.genie), ...moreGenieTools(deps.more), ...attentionTools(deps.attention), ...hostingTools(deps.hosting), ...processTools(deps.processes), ...flowTools(deps.flows), ...(deps.agents ? agentTools(deps.agents) : []), ...(deps.workspaceTabs ? workspaceTabsTools(deps.workspaceTabs) : []), ...(deps.pages ? pagesTools(deps.pages) : []), ...pluginTools(deps.plugins)];
}
