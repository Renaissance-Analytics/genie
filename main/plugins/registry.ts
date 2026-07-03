/**
 * The main-side plugin tool REGISTRY — the seam that lets enabled-plugin MCP
 * tools ride Genie's existing `tools/list` + `tools/call` surface (§5.1).
 *
 * The pure JSON-RPC handler (`mcp/protocol.ts`) calls two injected functions:
 *   - `pluginToolDescriptors()` — concatenated into `tools/list` (namespaced,
 *     fail-closed: a disabled or malformed plugin contributes NOTHING).
 *   - `dispatchPluginTool(name, args, terminalId)` — the fall-through for a
 *     namespaced tool call; resolves the owning plugin, runs its handler in the
 *     plugin's configured process (worker by default, §12.1), and returns the
 *     MCP `content` result. Errors are CONTAINED here (never thrown up into the
 *     transport) so a bad plugin can't poison the core tool surface.
 *
 * Tool CODE never runs in this module — it runs in the plugin's isolated
 * executor (a `utilityProcess` worker by default). The executor is INJECTABLE so
 * the seam is testable without spinning up Electron; the production default is
 * the worker executor (`./worker-host`), loaded lazily.
 */

import {
    listEnabledPlugins,
    getPlugin,
    type PluginRow,
} from '../db';
import {
    validatePluginManifest,
    namespacedToolName,
    type PluginManifest,
    type PluginMcpTool,
} from './manifest';

/** An MCP tool descriptor as `tools/list` returns it. */
export interface PluginToolDescriptor {
    name: string;
    description: string;
    inputSchema: unknown;
}

/** The MCP `content` result of a tool call. */
export interface PluginToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

/** Everything the executor needs to run one call in the plugin's process. */
export interface PluginToolExecution {
    plugin: PluginRow;
    manifest: PluginManifest;
    tool: PluginMcpTool;
    /** The bare tool name (un-namespaced), as the handler module exports it. */
    toolName: string;
    args: Record<string, unknown>;
    terminalId: string;
}

/**
 * Runs a plugin tool in its isolated process and returns the MCP result. The
 * default implementation is the `utilityProcess` worker host; tests inject a
 * fake. `dispose` tears down any worker for a plugin (on disable/uninstall).
 */
export interface PluginToolExecutor {
    call(exec: PluginToolExecution): Promise<PluginToolResult>;
    dispose(pluginId: string): void;
}

let executor: PluginToolExecutor | null = null;

/** Inject a custom executor (tests). */
export function setPluginToolExecutor(e: PluginToolExecutor | null): void {
    executor = e;
}

/** Resolve the active executor, lazily creating the worker host in production. */
function getExecutor(): PluginToolExecutor {
    if (executor) return executor;
    // Lazy require so importing the registry (e.g. in a unit test) never pulls
    // Electron's utilityProcess in. Only the real dispatch path reaches here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createWorkerExecutor } = require('./worker-host') as typeof import('./worker-host');
    executor = createWorkerExecutor();
    return executor;
}

/** Parse + validate a plugin row's stored manifest snapshot. Null if invalid. */
function manifestOf(plugin: PluginRow): PluginManifest | null {
    try {
        const parsed = JSON.parse(plugin.manifest_json) as unknown;
        const res = validatePluginManifest(parsed);
        return res.ok ? res.manifest : null;
    } catch {
        return null;
    }
}

/**
 * The namespaced tool descriptors for every ENABLED plugin. Fail-closed: any
 * plugin whose manifest snapshot is missing/invalid is skipped entirely, and the
 * whole thing degrades to `[]` on any unexpected error — a bad plugin never
 * removes or corrupts a CORE tool.
 */
export function pluginToolDescriptors(): PluginToolDescriptor[] {
    try {
        const out: PluginToolDescriptor[] = [];
        for (const plugin of listEnabledPlugins()) {
            const manifest = manifestOf(plugin);
            if (!manifest) continue; // fail-closed: skip a malformed plugin
            for (const tool of manifest.mcpTools ?? []) {
                out.push({
                    name: namespacedToolName(manifest.namespace, tool.name),
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                });
            }
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Resolve a namespaced tool name to its owning ENABLED plugin + tool. Returns
 * null when no enabled plugin owns it (so `tools/call` reports "unknown tool").
 */
function resolvePluginTool(
    name: string,
): { plugin: PluginRow; manifest: PluginManifest; tool: PluginMcpTool } | null {
    const dot = name.indexOf('.');
    if (dot <= 0) return null;
    const namespace = name.slice(0, dot);
    const bare = name.slice(dot + 1);
    for (const plugin of listEnabledPlugins()) {
        const manifest = manifestOf(plugin);
        if (!manifest || manifest.namespace !== namespace) continue;
        const tool = (manifest.mcpTools ?? []).find((t) => t.name === bare);
        if (tool) return { plugin, manifest, tool };
    }
    return null;
}

/** True when `name` is a namespaced tool owned by some enabled plugin. */
export function ownsPluginTool(name: string): boolean {
    return resolvePluginTool(name) !== null;
}

/**
 * Dispatch a plugin tool call. Resolves the owning enabled plugin, runs its
 * handler in the configured process, and returns the MCP result. NEVER throws:
 * an unknown tool, a disabled plugin, or a handler error all come back as an
 * `isError` content result so the JSON-RPC layer stays intact.
 */
export async function dispatchPluginTool(
    name: string,
    args: Record<string, unknown>,
    terminalId: string,
): Promise<PluginToolResult> {
    const resolved = resolvePluginTool(name);
    if (!resolved) {
        return errorResult(`No enabled plugin provides the tool "${name}".`);
    }
    const { plugin, manifest, tool } = resolved;
    try {
        return await getExecutor().call({
            plugin,
            manifest,
            tool,
            toolName: tool.name,
            args: args ?? {},
            terminalId,
        });
    } catch (e) {
        // Contained: a crashing/hanging worker or a thrown handler surfaces as a
        // tool error, not a transport failure.
        return errorResult(
            `Plugin "${plugin.name}" tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
}

/** Tear down any live worker for a plugin (call on disable/uninstall). */
export function disposePlugin(pluginId: string): void {
    try {
        executor?.dispose(pluginId);
    } catch {
        /* best-effort */
    }
}

function errorResult(text: string): PluginToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

/** Test/diagnostic: resolve a plugin row by id (thin re-export for callers). */
export function pluginById(id: string): PluginRow | null {
    return getPlugin(id);
}
