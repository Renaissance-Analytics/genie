import { OFFICIAL_PLUGINS } from '../core/official-plugins.js';
import type { ClaimingEditor } from '../core/plugin-editors.js';
import type { PluginCapabilities, PluginManifest } from '../core/plugins.js';
import type { PluginToolsDeps } from './mcp-tools-plugins.js';
import { runOfficialTool } from './official-tools.js';
import { OFFICIAL_LABEL, PluginHost, type PluginEntry } from './plugin-host.js';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launchSubprocessIn, runPluginTool } from './plugin-runner.js';
import type { EditorBytesDecision } from '../core/plugin-editors.js';
import type { PluginsApi } from './plugins-replica.js';

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
    readonly #listeners = new Set<(dump: PluginsDump) => void>();

    private constructor(plugins: PluginHost, open: () => Promise<PluginHost>) {
        this.#plugins = plugins;
        this.#open = open;
    }

    /** `publisherChecksOff` is read at every (re)open: the setting is the host's own (P3.2; ADF B5). */
    static async open(input: { dir: string; keys: Readonly<Record<string, string>>; publisherChecksOff: () => boolean }): Promise<PluginsService> {
        const open = () => PluginHost.open({ dir: input.dir, keys: input.keys, publisherChecksOff: input.publisherChecksOff(), official: OFFICIAL_PLUGINS });
        return new PluginsService(await open(), open);
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
                this.#plugins = await this.#open();
                this.#emit();
                return true;
            case 'uninstall':
                return this.#uninstall(String(args[0] ?? ''));
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

    /**
     * UNINSTALL (ADF A6): an installed plugin's folder goes, then the plugins are read again and told. Genie's own ship
     * with Genie and are refused; so is anything that is not a folder directly inside the plugins directory.
     */
    async #uninstall(pluginId: string): Promise<boolean> {
        const entry = this.#plugins.list().find((e) => e.id === pluginId);
        if (!entry) throw new Error(`no plugin ${pluginId} is installed`);
        if (entry.label === OFFICIAL_LABEL) throw new Error(`${pluginId} ships with Genie; turn it off instead`);
        const dir = this.#plugins.dir();
        const folder = resolve(dir, entry.folder);
        if (dirname(folder) !== resolve(dir) || entry.folder.length === 0) throw new Error(`${pluginId} is not a folder of the plugins directory`);
        await rm(folder, { recursive: true, force: true });
        this.#plugins = await this.#open();
        this.#emit();
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
