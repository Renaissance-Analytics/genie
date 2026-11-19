/**
 * THE WORKSPACE AGENT FILES ARE GENIE-HOST'S TO KEEP (Tynn #898 step 2e-2, story #914). The owner: Genie 2 manages them all
 * and upgrades Genie 1's. This loop used to run in the window, which reached genie-host's writers through the engine
 * server's engine.features route, so with no window open nothing was written. It runs in genie-host now, with the same
 * rules:
 *  - every workspace once, when genie-host's MCP server has started (the config names its endpoint, the protocol its tools);
 *  - each workspace added after, whichever path added it, once, by watching the registry;
 *  - THE WORK MODEL (Tynn story #402): a Tynn sign-in or sign-out changes what the protocol tells every agent about where
 *    its work is planned, so every workspace's protocol is written again (only a changed file is);
 *  - SIGNING IN TO TYNN LATER: each workspace linked to a Tynn project has its config synced again, so one with no token
 *    yet gets it now (one that already carries a token is not minted again).
 * A failure is said, by workspace, and never stops the others.
 */
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

export function syncWorkspaceFiles(ports: WorkspaceFilesSyncPorts): () => void {
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const docs = (w: { id: string; path: string }) => {
        void ports.syncAgentDocs(w.path).catch((error: unknown) => { ports.log(`[workspace-files] ${w.id} protocol: ${message(error)}`); });
    };
    const config = (w: { id: string; path: string }) => {
        void ports.syncConfig(w.path).then(
            (results) => { for (const r of results) if (!r.ok) ports.log(`[workspace-files] ${w.id} ${r.label}: ${r.error ?? 'failed'}`); },
            (error: unknown) => { ports.log(`[workspace-files] ${w.id}: ${message(error)}`); },
        );
    };
    const synced = new Set<string>();
    const syncNew = () => {
        for (const w of ports.workspaces()) {
            if (synced.has(w.path)) continue;
            synced.add(w.path);
            docs(w);
            config(w);
        }
    };
    syncNew();
    const offRegistry = ports.onWorkspacesChanged(syncNew);
    const offTynn = ports.onTynnChanged(() => {
        for (const w of ports.workspaces()) docs(w);
        if (!ports.tynnSignedIn()) return;
        for (const w of ports.workspaces()) if (ports.tynnProject(w.id) !== null) config(w);
    });
    return () => { offRegistry(); offTynn(); };
}
