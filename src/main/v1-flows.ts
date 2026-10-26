// RED-PHASE STUB (genie#1204).
import type { FlowStore } from './flow-store.js';
export async function runV1FlowImport(_flows: FlowStore, _input: { database: string; workspaces: readonly { id: string; path: string }[] }): Promise<{ sawV1: boolean; imported?: number; notes: string[] }> {
    return { sawV1: false, notes: [] };
}
