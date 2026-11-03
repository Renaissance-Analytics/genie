import type { GitConfigEntry, TrustList } from '../core/workspace-trust.js';

/** What a workspace's own files say would run, and the one verdict everything reads. Red: the shape only. */
export interface TrustListPorts {
    readText(path: string): Promise<string | null>;
    gitConfig(cwd: string): Promise<GitConfigEntry[]>;
}
export interface TrustView { readonly trusted: boolean; readonly changed: boolean; readonly list: TrustList }
export interface WorkspaceTrustPorts extends TrustListPorts {
    workspaces(): readonly { readonly id: string; readonly path: string }[];
    record(): { readonly carried: readonly string[]; readonly workspaces: Readonly<Record<string, string>> };
    recordWorkspace(workspaceId: string, hash: string): Promise<void>;
    approveSites(workspaceId: string): Promise<void>;
}

export async function readTrustList(_path: string, _ports: TrustListPorts): Promise<TrustList> {
    return { sites: [], hooks: [], servers: [], gitKeys: [] };
}

export class WorkspaceTrust {
    constructor(_ports: WorkspaceTrustPorts) { /* red */ }
    async refresh(_workspaceId: string): Promise<TrustView | null> { return { trusted: true, changed: false, list: { sites: [], hooks: [], servers: [], gitKeys: [] } }; }
    async trust(_workspaceId: string): Promise<TrustView | null> { return this.refresh(_workspaceId); }
    isTrustedPath(_path: string): boolean { return true; }
}
