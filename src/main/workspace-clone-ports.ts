import type { AgentRecord } from '../core/identity.js';
import type { ProcessSource } from '../core/workspace-processes.js';
import type { CloneRestorePorts } from './workspace-clone-restore-host.js';
import type { KeepInput } from './workspace-processes-host.js';

/** Inert stub (RED): the clone restore's ports from what a host holds (Tynn #756, PR9a). The implementation lands after the tests are seen failing. */

export interface CloneRestoreDeps {
    readonly files: { read(path: string): Promise<string | null>; list(dir: string): Promise<string[]> };
    readonly registry: {
        agentsOf(workspaceId: string): readonly { id: string; name: string }[];
        defaultAgentOf(workspaceId: string): string | null;
        setDefaultAgent(workspaceId: string, agentId: string): Promise<unknown>;
        listWorkspaces(): readonly { id: string; envFile?: string }[];
        setWorkspaceEnvFile(workspaceId: string, file: string | null): Promise<unknown>;
        workspaceMcpOff(workspaceId: string): string[];
        setWorkspaceMcpServer(workspaceId: string, name: unknown, on: unknown): Promise<unknown>;
        listAgents(): readonly AgentRecord[];
        workspaceSlugs(): ReadonlyMap<string, string>;
    };
    readonly settings: {
        workspaceValues(workspaceId: string): Readonly<Record<string, boolean | string>>;
        setFor(workspaceId: string, key: string, value: boolean | string): Promise<unknown>;
        get(key: string): unknown;
    };
    readonly flows: () => Promise<{
        list(workspaceId?: string): readonly { name: string; workspaceId: string; document: unknown }[];
        create(input: { workspaceId: string; name: string; document: unknown; by: { kind: 'user' } }): Promise<unknown>;
    } | null>;
    readonly processes: () => Promise<{
        kept(): readonly { name: string; workspaceId: string; command: string; cwd: string; restart: ProcessSource['restart']; schedule?: ProcessSource['schedule'] }[];
        keep(input: KeepInput): Promise<unknown>;
    } | null>;
    trusted(workspaceId: string): boolean;
    siteHosts(workspaceId: string): readonly string[];
}

export function cloneRestorePorts(_deps: CloneRestoreDeps): CloneRestorePorts {
    throw new Error('not implemented');
}
