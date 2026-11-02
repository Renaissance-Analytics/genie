import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configSync, type SyncResult } from '../core/integrations.js';
import { writeAgentGitignore } from './agent-gitignore.js';
import { configSyncTargets, type SyncFlags } from './config-sync-targets.js';
import { McpPreparationError } from './mcp-preparation-error.js';
import { nodeTynnConfigFs, reconcileLegacyTynnConfig } from './tynn-config-cleanup.js';

/**
 * ONE WRITER OF A WORKSPACE'S AGENT CONFIG (P3.4). The legacy cleanup and the normal sync read and rewrite the same three files, and each must hold the same lock, or a sync
 * that read before a cleanup writes the removed credential back. With a host, all of it runs in the host, under the lock its agent preparation holds; a window running its own
 * engine does the same under its own. A window with a host writes none of it, even when the host fails: that would be the second writer again.
 */
export interface WorkspaceConfigRequest {
    readonly workspacePath: string;
    readonly flags: SyncFlags;
    readonly endpoint: { readonly url: string; readonly token: string };
}

/** One at a time per workspace, in order. A failure does not stop what follows. */
export function configWriter(): <T>(path: string, run: () => Promise<T>) => Promise<T> {
    const work = new Map<string, Promise<unknown>>();
    return <T>(path: string, run: () => Promise<T>): Promise<T> => {
        const previous = work.get(path) ?? Promise.resolve();
        const next = previous.then(run, run).finally(() => { if (work.get(path) === next) work.delete(path); });
        work.set(path, next);
        return next;
    };
}

export async function writeWorkspaceConfig({ workspacePath, flags, endpoint }: WorkspaceConfigRequest): Promise<SyncResult[]> {
    const fs = {
        read: async (p: string) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
        write: async (p: string, text: string) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, text, 'utf8'); },
        remove: async (p: string) => { try { await unlink(p); } catch { /* not there: nothing to remove */ } },
        list: async (d: string) => { try { return await readdir(d); } catch { return []; } },
    };
    try {
        await reconcileLegacyTynnConfig({ workspacePath, fs: nodeTynnConfigFs(workspacePath) });
        await writeAgentGitignore({ workspacePath, fs });
    } catch {
        return [{ id: 'tynn', label: 'Tynn (legacy config cleanup)', ok: false, error: new McpPreparationError('config').message }];
    }
    return configSync(configSyncTargets({ workspacePath, fs, flags }), { GENIE_MCP_URL: endpoint.url, GENIE_MCP_TOKEN: endpoint.token });
}
