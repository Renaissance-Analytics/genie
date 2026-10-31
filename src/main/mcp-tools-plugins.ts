import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { AccessDecision, AccessRequest, PluginManifest, PluginTool } from '../core/plugins.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type McpCall, type Registration } from './mcp-tools.js';
import type { RunResult } from './plugin-runner.js';

/**
 * PLUGIN TOOLS ON GENIE'S MCP SURFACE (§6.7). Every ENABLED plugin's tools are offered to agents as
 * `<pluginId>.<tool>`; a disabled, refused or invalid plugin offers nothing. A call resolves the caller
 * from `GENIE_TERMINAL_ID` like every Genie tool, asks the person first when the tool is GATED (denied
 * → nothing runs), then runs the tool through the runner with the plugin's own guard — which is where
 * undeclared access stops existing.
 */

export interface PluginToolRef {
    readonly pluginId: string;
    readonly dir: string;
    readonly manifest: PluginManifest;
    readonly tool: PluginTool;
    /** Genie's own (an official plugin, beta.33 item 14): run in-process, not launched from a plugin folder. */
    readonly official?: boolean;
}

export interface PluginToolsDeps {
    readonly plugins: {
        /** The tools of ENABLED plugins, at the time of the call to `pluginTools`. */
        tools(): readonly PluginToolRef[];
        /** The plugin's guard, or null when it is not enabled any more. */
        guard(pluginId: string): ((request: AccessRequest) => AccessDecision) | null;
    };
    readonly run: (input: { dir: string; manifest: PluginManifest; tool: PluginTool; args: unknown; caller: Caller; guard: (request: AccessRequest) => AccessDecision; official?: boolean; pluginId?: string }) => Promise<RunResult>;
    readonly approve: (caller: Caller, action: 'plugin', detail: string, call: McpCall | undefined) => Promise<'allowed' | 'denied'>;
    readonly resolveCaller: (terminalId: string) => Caller | null;
}

/**
 * A plugin tool's TITLE: "<plugin name>: <tool name in words>" ("Spreadsheet: Create workbook"), in the sentence case Genie's
 * own tools use ("Manage terminals"). A manifest declares no tool title, and a tool without one goes out as `title: null`
 * on the modern protocol — Claude then rejects Genie's WHOLE tool list (2026-10-22: every Claude agent had no Genie tools).
 */
export function pluginToolTitle(pluginName: string, toolName: string): string {
    const words = toolName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase();
    const tool = words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : toolName;
    return `${pluginName}: ${tool}`;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

export function pluginTools(deps: PluginToolsDeps): Registration[] {
    return deps.plugins.tools().map((ref) => {
        const name = `${ref.pluginId}.${ref.tool.name}`;
        const schema = ref.tool.inputSchema;
        const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}), terminalId: MIRRORED_TERMINAL_ID };
        const definition = new ToolDefinition(
            name,
            `${ref.tool.description} (plugin ${ref.manifest.name} ${ref.manifest.version}${ref.tool.gated ? '; approval-gated' : ''})`,
            { ...schema, type: 'object', properties } as JsonObject,
            pluginToolTitle(ref.manifest.name, ref.tool.name),
        );
        const handler = async (args: JsonObject, context: { headers: Record<string, string> } & McpCall): Promise<McpToolResult> => {
            const caller = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof caller === 'string') return err(caller);
            const guard = deps.plugins.guard(ref.pluginId);
            if (!guard) return err(`plugin ${ref.pluginId} is not enabled`);
            const { terminalId: _omit, ...rest } = args;
            if (ref.tool.gated) {
                const verdict = await deps.approve(caller, 'plugin', name, context);
                if (verdict !== 'allowed') return err(`${name} was denied by the person; nothing ran`);
            }
            const result = await deps.run({ dir: ref.dir, manifest: ref.manifest, tool: ref.tool, args: rest, caller, guard, official: ref.official === true, pluginId: ref.pluginId });
            return result.ok ? ok(result) : err(result.reason);
        };
        return { definition, handler: handler as Registration['handler'] };
    });
}
