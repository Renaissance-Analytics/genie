import type { ProcessSource } from '../core/workspace-processes.js';

/** Inert stub (RED): a fresh clone's `.processes/` kept stopped (Tynn #756, PR6). The implementation lands after the tests are seen failing. */

export interface KeepInput {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly name: string;
    readonly command: string;
    readonly folder?: string | undefined;
    readonly restart: string;
    readonly schedule?: unknown;
    readonly enabled?: boolean | undefined;
}

export interface ProcessPorts {
    list(workspaceId: string): readonly ProcessSource[];
    keep(input: KeepInput): Promise<unknown>;
    agentAddressOf(workspaceId: string, name: string): string | null;
}

export interface ProcessRestore {
    readonly created: string[];
    readonly present: string[];
    readonly differs: string[];
    readonly waiting: { file: string; commands: string[] }[];
    readonly refused: { file: string; reason: string }[];
    readonly ignored: { file: string; keys: string[] }[];
}

export async function restoreProcesses(_files: readonly { path: string; text: string }[], _options: { workspaceId: string; workspacePath: string; ports: ProcessPorts; trusted: boolean }): Promise<ProcessRestore> {
    return { created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] };
}
