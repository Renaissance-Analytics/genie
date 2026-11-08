import { OFFICIAL_PLUGINS } from '../core/official-plugins.js';
import type { ClaimingEditor } from '../core/plugin-editors.js';
import type { PluginCapabilities, PluginManifest } from '../core/plugins.js';
import type { PluginToolsDeps } from './mcp-tools-plugins.js';
import { runOfficialTool } from './official-tools.js';
import { PluginHost, type PluginEntry } from './plugin-host.js';
import { launchSubprocessIn, runPluginTool } from './plugin-runner.js';
import type { EditorBytesDecision } from '../core/plugin-editors.js';
import type { PluginsApi } from './plugins-replica.js';
import type { PublisherKeyRegistry } from './marketplace-client.js';

/**
 * THE PLUGINS ARE GENIE-HOST'S (ADF A3, Tynn #447; spec .ai/plans/specs/adf-sdk.md). The host opens the plugin host over
 * `<root>/plugins` and keeps it: its MCP server offers and RUNS the plugins' tools with no window (an official one in
 * process, anyone else's in its sandboxed child), and every window reads the plugins — the list, the panels and editors —
 * through its replica (main/plugins-replica.ts), which asks the host to change them. Closing a window unregisters nothing.
 *
 * The whole state is sent as `plugins.event` before `engine.ready` and again on every change.
 */

export interface PluginsDump {
    readonly entries: readonly PluginEntry[];
    readonly panels: ReturnType<PluginHost['panels']>;
    readonly editors: readonly ClaimingEditor[];
    /** Every installable plugin's manifest: a window decides an editor's file access from it (`editorBytesAccess`, pure). */
    readonly manifests: Readonly<Record<string, PluginManifest>>;
}

export class PluginsService {
    #plugins: PluginHost;
    readonly #open: () => Promise<PluginHost>;
    readonly #registry: PublisherKeyRegistry | undefined;
    #refreshing: Promise<boolean> | null = null;
    readonly #listeners = new Set<(dump: PluginsDump) => void>();

    private constructor(plugins: PluginHost, open: () => Promise<PluginHost>, registry?: PublisherKeyRegistry) {
        this.#plugins = plugins;
        this.#open = open;
        this.#registry = registry;
    }

    /** `publisherChecksOff` is read at every (re)open: the setting is the host's own (P3.2; ADF B5). */
    static async open(input: { dir: string; keys: Readonly<Record<string, string>>; publisherChecksOff: () => boolean; registry?: PublisherKeyRegistry }): Promise<PluginsService> {
        const registry = input.registry;
        const open = () => PluginHost.open({
            dir: input.dir,
            keys: registry?.publisherKeys(input.keys) ?? input.keys,
            publisherChecksOff: input.publisherChecksOff(), official: OFFICIAL_PLUGINS,
            ...(registry ? { keyState: (id: string) => Object.hasOwn(input.keys, id) ? 'trusted' as const : registry.keyState(id) } : {}),
        });
        return new PluginsService(await open(), open, registry);
    }

    /** The plugin host now (a refresh replaces it). */
    plugins(): PluginHost {
        return this.#plugins;
    }

    dump(): PluginsDump {
        const p = this.#plugins;
        return { entries: p.list(), panels: p.panels(), editors: p.editors(), manifests: p.manifests() };
    }

    onEvent(listener: (dump: PluginsDump) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /**
     * A window's change: `setEnabled [id, enabled]` (persisted; `false` for one that is not installable) or `refresh []`
     * (re-read the folder: developer mode flipped, a plugin was dropped in). The new state is told BEFORE the answer, so a
     * window's replica has it by the time its call returns.
     */
    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        switch (method) {
            case 'setEnabled': {
                const changed = await this.#plugins.setEnabled(String(args[0] ?? ''), args[1] === true);
                if (changed) this.#emit();
                return changed;
            }
            case 'refresh':
                this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = null; });
                return this.#refreshing;
            case 'setNetworkAllowed': {
                // ADF B5: an Unverified package's network, allowed or taken back by the person; kept.
                const changed = await this.#plugins.setNetworkAllowed(String(args[0] ?? ''), args[1] === true);
                if (changed) this.#emit();
                return changed;
            }
            default:
                throw new Error(`the plugins have no ${method}`);
        }
    }

    async #refresh(): Promise<boolean> {
        let failure: unknown;
        let failed = false;
        try { await this.#registry?.refresh(); }
        catch (error) { failed = true; failure = error; }
        // Even offline, re-open against current cache freshness and any completed-snapshot withdrawals.
        this.#plugins = await this.#open();
        this.#emit();
        if (failed) throw failure;
        return true;
    }

    #emit(): void {
        const dump = this.dump();
        for (const listener of [...this.#listeners]) listener(dump);
    }
}

/**
 * A WINDOW WITH NO GENIE-HOST keeps its plugins (the coordinator's ruling for the owner, 2026-11-08: "a window with no
 * genie-host still loads plugins itself, as today, so there's no regression. genie-host owns them whenever it's present").
 * Its own plugin host, re-opened on refresh, behind the same surface a window reads the host's through; and its tools,
 * which that window then serves itself (`localPluginTools`).
 */
export class LocalPlugins implements PluginsApi {
    #host: PluginHost;
    readonly #open: () => Promise<PluginHost>;

    private constructor(host: PluginHost, open: () => Promise<PluginHost>) {
        this.#host = host;
        this.#open = open;
    }

    static async start(open: () => Promise<PluginHost>): Promise<LocalPlugins> {
        return new LocalPlugins(await open(), open);
    }

    list(): readonly PluginEntry[] { return this.#host.list(); }
    panels(): PluginsDump['panels'] { return this.#host.panels(); }
    editors(): readonly ClaimingEditor[] { return this.#host.editors(); }
    editorBytes(pluginId: string, path: string): EditorBytesDecision { return this.#host.editorBytes(pluginId, path); }
    setEnabled(pluginId: string, enabled: boolean): Promise<boolean> { return this.#host.setEnabled(pluginId, enabled); }
    setNetworkAllowed(pluginId: string, allowed: boolean): Promise<boolean> { return this.#host.setNetworkAllowed(pluginId, allowed); }
    /** What an enabled plugin's tool may reach as it runs (ADF B5). */
    capabilities(pluginId: string): PluginCapabilities | null { return this.#host.capabilities(pluginId); }
    async refresh(): Promise<void> { this.#host = await this.#open(); }
    /** The ENABLED plugins' tools and each one's guard, live across a refresh. */
    tools(): ReturnType<PluginHost['tools']> { return this.#host.tools(); }
    guard(pluginId: string): ReturnType<PluginHost['guard']> { return this.#host.guard(pluginId); }
    /** Every installable plugin's manifest, for the catalog built from these plugins (ADF A5). */
    manifests(): ReturnType<PluginHost['manifests']> { return this.#host.manifests(); }
}

export interface PluginToolsRunOptions {
    /** Where a plugin's child is launched from (`<root>/plugin-sandbox`). */
    readonly sandboxDir: string;
    /** The Genie API a plugin may ask for, by name. */
    readonly api: (method: string, params: unknown) => Promise<unknown>;
}

/** The plugins' tools as the host's MCP server runs them (ADF A3): genie-host's own plugins. */
export function hostPluginTools(service: PluginsService, opts: PluginToolsRunOptions): PluginToolsDeps['plugins'] & { readonly run: PluginToolsDeps['run'] } {
    return localPluginTools({ tools: () => service.plugins().tools(), guard: (id) => service.plugins().guard(id), capabilities: (id) => service.plugins().capabilities(id) }, opts);
}

/**
 * The plugins' tools from a source of them: the ENABLED plugins' tools, each plugin's guard, and the run — an official
 * tool in process (main/official-tools.ts), anyone else's in its sandboxed child (main/plugin-runner.ts, genie#871: its
 * folder, the workspace only if declared, the declared hosts only). genie-host's, or a window's with no genie-host.
 */
export function localPluginTools(source: Pick<PluginToolsDeps['plugins'], 'tools' | 'guard'> & { capabilities?(pluginId: string): PluginCapabilities | null }, opts: PluginToolsRunOptions): PluginToolsDeps['plugins'] & { readonly run: PluginToolsDeps['run'] } {
    return {
        tools: () => source.tools(),
        guard: (id) => source.guard(id),
        run: (input) => input.official
            ? runOfficialTool({ pluginId: input.manifest.id, tool: input.tool.name, args: input.args, caller: input.caller, manifest: input.manifest })
            : runPluginTool({
                pluginDir: input.dir,
                tool: input.tool,
                args: input.args,
                caller: { agentName: input.caller.agentName, workspaceId: input.caller.workspaceId, workspacePath: input.caller.workspacePath },
                guard: input.guard,
                api: opts.api,
                launch: launchSubprocessIn(opts.sandboxDir),
                // Read AT THE RUN (ADF B5): an Unverified package's network follows the person's allowing, even for a tool
                // registered before it. A plugin no longer enabled reaches nothing.
                capabilities: source.capabilities ? (source.capabilities(input.pluginId ?? input.manifest.id) ?? { network: { hosts: [] }, genieApi: [] }) : input.manifest.capabilities,
                timeoutMs: 30_000,
                label: `${input.manifest.id}.${input.tool.name}`,
            }),
    };
}
