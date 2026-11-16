/** Inert stub (RED): a fresh clone's `.flows/` restored, disarmed (Tynn #756, PR5). The implementation lands after the tests are seen failing. */

export interface FlowPorts {
    list(workspaceId: string): readonly { readonly name: string; readonly document: unknown }[];
    create(input: { workspaceId: string; name: string; document: unknown; by: { kind: 'user' } }): Promise<unknown>;
}

export interface FlowRestore {
    readonly created: string[];
    readonly present: string[];
    readonly differs: string[];
    readonly waiting: { file: string; commands: string[] }[];
    readonly refused: { file: string; reason: string }[];
    readonly ignored: { file: string; keys: string[] }[];
}

export async function restoreFlows(_files: readonly { path: string; text: string }[], _workspaceId: string, _ports: FlowPorts, _options: { trusted: boolean }): Promise<FlowRestore> {
    return { created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] };
}
