import { OFFICIAL_PLUGINS } from '../core/official-plugins.js';
import type { ClaimingEditor } from '../core/plugin-editors.js';
import type { PluginManifest } from '../core/plugins.js';
import type { PluginToolsDeps } from './mcp-tools-plugins.js';
import { runOfficialTool } from './official-tools.js';
import { PluginHost, type PluginEntry } from './plugin-host.js';
import { launchSubprocessIn, runPluginTool } from './plugin-runner.js';

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

    /** `developerMode` is read at every (re)open: the setting is the host's own (P3.2). */
    static async open(input: { dir: string; keys: Readonly<Record<string, string>>; developerMode: () => boolean }): Promise<PluginsService> {
        const open = () => PluginHost.open({ dir: input.dir, keys: input.keys, developerMode: input.developerMode(), official: OFFICIAL_PLUGINS });
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
            default:
                throw new Error(`the plugins have no ${method}`);
        }
    }

    #emit(): void {
        const dump = this.dump();
        for (const listener of [...this.#listeners]) listener(dump);
    }
}

/**
 * The plugins' tools as the host's MCP server runs them: the ENABLED plugins' tools, each plugin's guard, and the run —
 * an official tool in process (main/official-tools.ts), anyone else's in its sandboxed child (main/plugin-runner.ts,
 * genie#871: its folder, the workspace only if declared, the declared hosts only).
 */
export function hostPluginTools(service: PluginsService, opts: {
    /** Where a plugin's child is launched from (`<root>/plugin-sandbox`). */
    readonly sandboxDir: string;
    /** The Genie API a plugin may ask for, by name. */
    readonly api: (method: string, params: unknown) => Promise<unknown>;
}): PluginToolsDeps['plugins'] & { readonly run: PluginToolsDeps['run'] } {
    return {
        tools: () => service.plugins().tools(),
        guard: (id) => service.plugins().guard(id),
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
                capabilities: input.manifest.capabilities,
                timeoutMs: 30_000,
                label: `${input.manifest.id}.${input.tool.name}`,
            }),
    };
}
