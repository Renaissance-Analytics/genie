// RED STUB (Tynn #914): the shape only; it syncs nothing.
export interface WorkspaceFilesSyncPorts {
    workspaces(): readonly { id: string; path: string }[];
    onWorkspacesChanged(listener: () => void): () => void;
    tynnSignedIn(): boolean;
    onTynnChanged(listener: () => void): () => void;
    tynnProject(workspaceId: string): string | null;
    syncAgentDocs(path: string): Promise<unknown>;
    syncConfig(path: string): Promise<readonly { ok: boolean; label: string; error?: string | null }[]>;
    log(line: string): void;
}

export function syncWorkspaceFiles(_ports: WorkspaceFilesSyncPorts): () => void {
    return () => {};
}
