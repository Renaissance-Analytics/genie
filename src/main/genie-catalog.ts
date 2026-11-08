import { Catalog, type ElementDefinition, type ElementSource } from '../core/catalog.js';
import { OFFICIAL_PLUGINS } from '../core/official-plugins.js';
import { parseManifest, type PluginManifest } from '../core/plugins.js';
import type { BuiltinTool } from './builtin-tool.js';
import { AGENT_TOOLS } from './mcp-tools-agents.js';
import { ATTENTION_TOOLS } from './mcp-tools-attention.js';
import { FLOWS_TOOLS } from './mcp-tools-flows.js';
import { HOSTING_TOOLS } from './mcp-tools-hosting.js';
import { MORE_TOOLS } from './mcp-tools-more.js';
import { PAGES_TOOLS } from './mcp-tools-pages.js';
import { pluginToolOffer } from './mcp-tools-plugins.js';
import { PROCESS_TOOLS } from './mcp-tools-processes.js';
import { WORKSPACE_TABS_TOOLS } from './mcp-tools-workspace-tabs.js';
import { GENIE_TOOLS } from './mcp-tools.js';

/**
 * GENIE'S OWN ELEMENTS IN THE CATALOG (ADF A2, Tynn #446; spec .ai/plans/specs/adf-sdk.md). Builtins go through the SAME
 * path as anyone's: the 17 builtin MCP tools (each module's compiled declarations) are one package, `ai.genie.core`, and
 * each of the five official plugins is its own package, normalized from its manifest exactly as an installed plugin's
 * is — and every one of them passes A1's validator (core/catalog.ts) or the catalog does not start. `allGenieTools`
 * (main/mcp-registrations.ts) offers what this catalog holds.
 */

export const BUILTIN_PACKAGE_ID = 'ai.genie.core';
const BUILTIN_VERSION = '2.0.0';

/** The 17 builtin tools, in the order agents have always been offered them. */
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
    ...GENIE_TOOLS, ...MORE_TOOLS, ...ATTENTION_TOOLS, ...HOSTING_TOOLS, ...PROCESS_TOOLS, ...FLOWS_TOOLS,
    ...AGENT_TOOLS, ...WORKSPACE_TABS_TOOLS, ...PAGES_TOOLS,
];

/** A package as it is handed to `Catalog.register`: plain data, validated there. */
export interface PackageDeclaration {
    readonly id: string;
    readonly version: string;
    readonly source: ElementSource;
    readonly contributions: readonly ElementDefinition[];
}

/** An MCP tool runs on the host, for an agent of this machine. */
const TOOL_REACH: ElementDefinition['reach'] = { scopes: ['workspace'], side: 'host', requiresWindow: false, remote: 'local' };
/** An editor or panel is drawn by a window, which may be another machine's. */
const VIEW_REACH: ElementDefinition['reach'] = { scopes: ['workspace'], side: 'client', requiresWindow: true, remote: 'allowed' };

export function builtinToolPackage(tools: readonly BuiltinTool[]): PackageDeclaration {
    return {
        id: BUILTIN_PACKAGE_ID,
        version: BUILTIN_VERSION,
        source: 'builtin',
        contributions: tools.map((t) => ({
            id: t.name,
            kind: 'tool',
            version: BUILTIN_VERSION,
            packageId: BUILTIN_PACKAGE_ID,
            source: 'builtin',
            aliases: [],
            docs: { name: t.title, description: t.description },
            reach: TOOL_REACH,
            permissions: { capabilities: [], network: [] },
            payload: { handler: t.name, inputSchema: t.inputSchema, ...(t.annotations === undefined ? {} : { annotations: t.annotations }) },
        })),
    };
}

/**
 * A parsed plugin manifest as a package: its tools, editors and panels. The official plugins come through here too,
 * with source `builtin` (they are compiled into the signed app); an installed one, with `plugin`.
 */
export function pluginPackage(manifest: PluginManifest, source: ElementSource): PackageDeclaration {
    const base = { version: manifest.version, packageId: manifest.id, source, aliases: [] as string[] };
    const permissions = {
        capabilities: [...manifest.capabilities.genieApi, ...(manifest.capabilities.fs ? ['fs:workspace'] : [])],
        network: [...manifest.capabilities.network.hosts],
    };
    const tools: ElementDefinition[] = manifest.mcpTools.map((tool) => {
        const offer = pluginToolOffer(manifest.id, manifest, tool);
        return {
            ...base, id: offer.name, kind: 'tool', reach: TOOL_REACH, permissions,
            docs: { name: offer.title, description: offer.description },
            payload: { handler: offer.name, inputSchema: offer.inputSchema, process: tool.process, gated: tool.gated },
        };
    });
    const editors: ElementDefinition[] = (manifest.editors ?? []).map((e) => ({
        ...base, id: `${manifest.id}.${e.id}`, kind: 'editor', reach: VIEW_REACH, permissions,
        docs: { name: e.title, description: `${manifest.name}: opens ${e.extensions.join(', ')} in ${e.title}.` },
        payload: { title: e.title, extensions: [...e.extensions], fancyEditor: e.fancyEditor.export },
    }));
    const panels: ElementDefinition[] = manifest.panels.map((p) => ({
        ...base, id: `${manifest.id}.${p.id}`, kind: 'panel', reach: VIEW_REACH, permissions,
        docs: { name: p.title, description: `${manifest.name}: the ${p.title} panel.` },
        payload: { title: p.title, fancyComponent: p.fancyComponent.export, props: { ...p.props } },
    }));
    return { id: manifest.id, version: manifest.version, source, contributions: [...tools, ...editors, ...panels] };
}

/**
 * Genie's catalog: the builtin tools, then the official plugins in their order. A builtin that does not validate is a
 * build fault, said loudly here — never quietly left out.
 */
export function genieCatalog(opts: { builtins?: readonly BuiltinTool[] } = {}): Catalog {
    const catalog = new Catalog();
    const packages: PackageDeclaration[] = [builtinToolPackage(opts.builtins ?? BUILTIN_TOOLS)];
    for (const official of OFFICIAL_PLUGINS) {
        const parsed = parseManifest(official.manifest);
        if (!parsed.ok) throw new Error(`official plugin ${String(official.manifest.id)} does not parse: ${parsed.reason}`);
        packages.push(pluginPackage(parsed.manifest, 'builtin'));
    }
    for (const pkg of packages) {
        const r = catalog.register(pkg);
        if (!r.ok) throw new Error(`builtin package ${pkg.id} was refused by the catalog: ${r.problems.join('; ')}`);
    }
    return catalog;
}
