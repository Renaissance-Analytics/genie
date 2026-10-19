import { genieTools, type GenieToolsDeps, type Registration } from './mcp-tools.js';
import { attentionTools, type AttentionToolsDeps } from './mcp-tools-attention.js';
import { hostingTools, type HostingToolsDeps } from './mcp-tools-hosting.js';
import { moreGenieTools, type MoreToolsDeps } from './mcp-tools-more.js';
import { pluginTools, type PluginToolsDeps } from './mcp-tools-plugins.js';
import { processTools, type ProcessToolsDeps } from './mcp-tools-processes.js';

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
    readonly plugins: PluginToolsDeps;
}

export function allGenieTools(deps: AllToolsDeps): Registration[] {
    return [...genieTools(deps.genie), ...moreGenieTools(deps.more), ...attentionTools(deps.attention), ...hostingTools(deps.hosting), ...processTools(deps.processes), ...pluginTools(deps.plugins)];
}
