import type { SyncResult } from '../core/integrations.js';
import type { SyncFlags } from './config-sync-targets.js';

export interface WorkspaceConfigRequest {
    readonly workspacePath: string;
    readonly flags: SyncFlags;
    readonly endpoint: { readonly url: string; readonly token: string };
}

export function configWriter(): <T>(path: string, run: () => Promise<T>) => Promise<T> { throw new Error('not built yet'); }
export function writeWorkspaceConfig(_request: WorkspaceConfigRequest): Promise<SyncResult[]> { throw new Error('not built yet'); }
