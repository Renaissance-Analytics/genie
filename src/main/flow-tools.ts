// RED-PHASE STUB (genie#1204): the shape the tests call, with no behaviour yet.
import type { NodeKindDefinition } from '@particle-academy/fancy-flow/engine';
import type { FlowRecord } from './flow-store.js';
import type { Caller, Registration } from './mcp-tools.js';

export const FLOW_TOOLS: readonly string[] = [];
export class FlowCallers {
    constructor(_workspacePath: (workspaceId: string) => string | null) {}
    callerFor(_key: string): Caller | null { return null; }
}
export function flowToolDefinitions(): NodeKindDefinition[] { return []; }
export function ensureFlowToolKinds(): void {}
export function createFlowToolCaller(_deps: { registrations: readonly Registration[]; callers: FlowCallers }): (flow: FlowRecord, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return async () => ({ ok: false, error: 'not built yet' });
}
