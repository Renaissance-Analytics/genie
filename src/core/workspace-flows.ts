import type { Exclusion } from './workspace-elements.js';

/** Inert stubs (RED): flows saved to `.flows/<name>.json` (Tynn #756, PR5). The implementation lands after the tests are seen failing. */

export const WORKSPACE_TOKEN = '${workspace}';

export function flowFileName(name: string, _taken: ReadonlySet<string>): string {
    return name;
}

export interface FlowSource {
    readonly name: string;
    readonly workspaceId: string;
    readonly document: Record<string, unknown>;
}

export function flowsDeclaration(_flows: readonly FlowSource[], _workspaceId: string): { files: { path: string; value: unknown }[]; excluded: Exclusion[] } {
    return { files: [], excluded: [] };
}

export interface FlowTrustItem {
    readonly file: string;
    readonly commands: readonly string[];
}

export function flowTrustItems(_files: readonly { path: string; value: unknown }[]): FlowTrustItem[] {
    return [];
}

export function rebindFlow(document: unknown, _workspaceId: string): unknown {
    return document;
}
