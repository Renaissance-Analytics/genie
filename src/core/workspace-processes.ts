import type { Exclusion } from './workspace-elements.js';

/** Inert stubs (RED): processes saved to `.processes/<name>.json` (Tynn #756, PR6). The implementation lands after the tests are seen failing. */

export const PROCESS_SCHEMA_URL = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/process.schema.json';

export interface ProcessSource {
    readonly name: string;
    readonly workspaceId: string;
    readonly command: string;
    readonly cwd: string;
    readonly restart: 'never' | 'on-failure' | 'always';
    readonly schedule?: { readonly cron: string; readonly kind: 'command' | 'agent-nudge'; readonly prompt?: string; readonly agent?: string; readonly lastRunAt?: number; readonly lastRunStatus?: string };
}

export function processesDeclaration(_processes: readonly ProcessSource[], _workspaceId: string, _workspacePath: string): { files: { path: string; value: unknown }[]; excluded: Exclusion[] } {
    return { files: [], excluded: [] };
}

export interface ProcessTrustItem {
    readonly file: string;
    readonly commands: readonly string[];
}

export function processTrustItems(_files: readonly { path: string; value: unknown }[]): ProcessTrustItem[] {
    return [];
}
