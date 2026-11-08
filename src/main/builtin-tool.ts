import { ToolDefinition, type JsonObject } from '@particle-academy/prism-mcp';

/**
 * A BUILTIN TOOL'S COMPILED DECLARATION (ADF A2, Tynn #446): its name, words and input schema, as plain data at the
 * module's top level — no deps, no handler. The catalog registers it through the same validator a plugin's tool goes
 * through (main/genie-catalog.ts), and the module's handler is bound to it by name. What an agent is offered is what
 * the catalog holds.
 */
export interface BuiltinTool {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
    readonly annotations?: JsonObject;
}

/** In ToolDefinition's own argument order, so a declaration reads as the definition it replaced. */
export function declareBuiltinTool(name: string, description: string, inputSchema: JsonObject, title: string, annotations?: JsonObject): BuiltinTool {
    return { name, title, description, inputSchema, ...(annotations === undefined ? {} : { annotations }) };
}

/** The MCP definition a declaration goes out as. */
export function builtinToolDefinition(tool: BuiltinTool): ToolDefinition {
    return tool.annotations === undefined
        ? new ToolDefinition(tool.name, tool.description, tool.inputSchema, tool.title)
        : new ToolDefinition(tool.name, tool.description, tool.inputSchema, tool.title, tool.annotations);
}
