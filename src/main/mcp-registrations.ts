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
import type { Catalog } from '../core/catalog.js';
import { genieCatalog, pluginPackage } from './genie-catalog.js';

/**
 * EVERY GENIE TOOL, ONCE (§6.9), AS THE CATALOG HOLDS THEM (ADF A2, Tynn #446). What is offered is the catalog's tools,
 * in the catalog's order (main/genie-catalog.ts): the builtin tools, the official plugins' tools, then each enabled
 * installed plugin's, registered as its own package through the same validator. The tool modules supply HANDLERS, bound
 * by name; a tool the catalog does not hold is not offered, and a part that is absent (doctor mode has no agents) offers
 * nothing for its tools. A plugin that does not register — it does not validate, or it poses as a package already
 * there — offers nothing.
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

export function allGenieTools(deps: AllToolsDeps, catalog: Catalog = genieCatalog()): Registration[] {
    const refs = deps.plugins.plugins.tools();
    // Each plugin's package, once: Genie's own are already in the catalog; an installed one registers here.
    const admitted = new Set<string>();
    const seen = new Set<string>();
    for (const ref of refs) {
        if (seen.has(ref.pluginId)) continue;
        seen.add(ref.pluginId);
        if (ref.official === true) {
            if (catalog.packages().some((p) => p.id === ref.pluginId && p.source === 'builtin')) admitted.add(ref.pluginId);
            continue;
        }
        if (ref.manifest.id === ref.pluginId && catalog.register(pluginPackage(ref.manifest, 'plugin')).ok) admitted.add(ref.pluginId);
    }
    const handlers = new Map<string, Registration>();
    const bind = (registrations: readonly Registration[]) => { for (const r of registrations) handlers.set(r.definition.name, r); };
    bind(genieTools(deps.genie));
    bind(moreGenieTools(deps.more));
    bind(attentionTools(deps.attention));
    bind(hostingTools(deps.hosting));
    bind(processTools(deps.processes));
    bind(flowTools(deps.flows));
    if (deps.agents) bind(agentTools(deps.agents));
    if (deps.workspaceTabs) bind(workspaceTabsTools(deps.workspaceTabs));
    if (deps.pages) bind(pagesTools(deps.pages));
    bind(pluginTools({ ...deps.plugins, plugins: { ...deps.plugins.plugins, tools: () => refs.filter((ref) => admitted.has(ref.pluginId)) } }));
    return catalog.list('tool').flatMap((d) => {
        const r = handlers.get(String(d.payload.handler));
        return r ? [r] : [];
    });
}
