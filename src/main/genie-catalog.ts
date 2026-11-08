import { Catalog, type ElementDefinition, type ElementSource } from '../core/catalog.js';
import { OFFICIAL_PLUGINS } from '../core/official-plugins.js';
import { parseManifest, type PluginManifest } from '../core/plugins.js';
import type { BuiltinTool } from './builtin-tool.js';
import { AGENT_TOOLS } from './mcp-tools-agents.js';
import { ATTENTION_TOOLS } from './mcp-tools-attention.js';
import { FLOWS_TOOLS } from './mcp-tools-flows.js';
import { HOSTING_TOOLS } from './mcp-tools-hosting.js';
import { MAIL_TOOLS } from './mcp-tools-mail.js';
import { MORE_TOOLS } from './mcp-tools-more.js';
import { PAGES_TOOLS } from './mcp-tools-pages.js';
import { pluginToolOffer } from './mcp-tools-plugins.js';
import { PROCESS_TOOLS } from './mcp-tools-processes.js';
import { WORKSPACE_TABS_TOOLS } from './mcp-tools-workspace-tabs.js';
import { GENIE_TOOLS } from './mcp-tools.js';
import { PERSON_ONLY_TOOLS } from '../core/gapp-grants.js';

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
    ...GENIE_TOOLS, ...MORE_TOOLS, ...ATTENTION_TOOLS, ...HOSTING_TOOLS, ...PROCESS_TOOLS, ...FLOWS_TOOLS, ...MAIL_TOOLS,
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
/**
 * An editor or panel is drawn by a window, which may be another machine's. Where its vetted adapter works on the host's
 * data, it runs on BOTH sides, over these host calls (the owner's ruling q_d71981d6); a panel that only draws its props
 * is the client's alone.
 */
const ADAPTER_LINKS: Readonly<Record<string, readonly string[]>> = {
    Editor: ['files.readBytes', 'files.writeBytes'],
    SheetWorkbook: ['files.readBytes', 'files.writeBytes'],
    DeckEditor: ['files.readBytes', 'files.writeBytes'],
    RepoChangesPanel: ['repo.call'],
    ArtBoardPanel: ['artboard.read', 'artboard.review'],
};
function viewReach(adapter: string): ElementDefinition['reach'] {
    const calls = ADAPTER_LINKS[adapter];
    return calls
        ? { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'allowed', link: { calls, events: [] } }
        : { scopes: ['workspace'], side: 'client', requiresWindow: true, remote: 'allowed' };
}

/**
 * REMOTE ACCESS (Tynn #409, host split P5d.1; the owner: the host split is built on ADF). A host-service on BOTH sides:
 * genie-host runs the tailnet listener, the remote host, the paired devices, the PIN, the baton and the lock, window or
 * not (remote-access-host.ts); this machine's own window draws Settings → Workstation's remote section and drives it. The
 * engine link's `engine.remoteAccess` call and `remoteAccess.event` event are the only channel between them.
 */
export const REMOTE_ACCESS_ELEMENT: ElementDefinition = {
    id: 'genie.remote-access',
    kind: 'host-service',
    version: BUILTIN_VERSION,
    packageId: BUILTIN_PACKAGE_ID,
    source: 'builtin',
    docs: { name: 'Remote access', description: 'A paired phone (over the tailnet) or a Pilot (over the Tynn relay) reaches this machine, with every Genie window closed. One baton, one lock, one list of paired devices.' },
    reach: { scopes: ['workstation'], side: 'both', requiresWindow: false, remote: 'local', link: { calls: ['engine.remoteAccess'], events: ['remoteAccess.event'] } },
    permissions: { capabilities: [], network: [] },
    payload: { start: 'remoteAccess.start', stop: 'remoteAccess.stop', health: 'remoteAccess.health', settingsSection: 'workstation' },
};

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
            docs: { name: t.title, description: t.description },
            reach: TOOL_REACH,
            permissions: { capabilities: [], network: [] },
            payload: {
                handler: t.name, inputSchema: t.inputSchema, ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
                // GApps v2 decision 3: a tool that acts as the person, or waits on their approval, is never granted to an app.
                ...(PERSON_ONLY_TOOLS.has(t.name) ? { grantable: false } : {}),
            },
        } as ElementDefinition)).concat([REMOTE_ACCESS_ELEMENT]),
    };
}

/**
 * A parsed plugin manifest as a package: its tools, editors and panels. The official plugins come through here too,
 * with source `builtin` (they are compiled into the signed app); an installed one, with `plugin`.
 */
export function pluginPackage(manifest: PluginManifest, source: ElementSource): PackageDeclaration {
    const base = { version: manifest.version, packageId: manifest.id, source };
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
        ...base, id: `${manifest.id}.${e.id}`, kind: 'editor', reach: viewReach(e.fancyEditor.export), permissions,
        docs: { name: e.title, description: `${manifest.name}: opens ${e.extensions.join(', ')} in ${e.title}.` },
        payload: { title: e.title, extensions: [...e.extensions], fancyEditor: e.fancyEditor.export },
    }));
    const panels: ElementDefinition[] = manifest.panels.map((p) => ({
        ...base, id: `${manifest.id}.${p.id}`, kind: 'panel', reach: viewReach(p.fancyComponent.export), permissions,
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

/**
 * THE HOST'S CATALOG NOW (ADF A4): Genie's own, then every ENABLED installed plugin as its own package. One that does not
 * register (it does not validate, or it poses as a package already there) is left out, as allGenieTools leaves it out.
 */
export function hostCatalog(plugins: { tools(): readonly { pluginId: string; manifest: PluginManifest; official?: boolean }[]; manifests?(): Readonly<Record<string, PluginManifest>>; list?(): readonly { id: string; state: string }[] }): Catalog {
    const catalog = genieCatalog();
    const enabled = new Map<string, PluginManifest>();
    for (const ref of plugins.tools()) if (ref.official !== true) enabled.set(ref.pluginId, ref.manifest);
    // A plugin with editors or panels but no tools is in the catalog too.
    const manifests = plugins.manifests?.() ?? {};
    for (const entry of plugins.list?.() ?? []) {
        const m = manifests[entry.id];
        if (entry.state === 'enabled' && m && !catalog.packages().some((p) => p.id === entry.id)) enabled.set(entry.id, m);
    }
    for (const manifest of enabled.values()) catalog.register(pluginPackage(manifest, 'plugin'));
    return catalog;
}
