import { readdir, readFile } from 'node:fs/promises';
import { agentAddress } from '../core/inbox.js';
import type { AgentRecord } from '../core/identity.js';
import type { ProcessSource } from '../core/workspace-processes.js';
import type { CloneRestorePorts } from './workspace-clone-restore-host.js';
import type { KeepInput } from './workspace-processes-host.js';

/**
 * THE CLONE RESTORE'S PORTS, FROM WHAT A HOST HOLDS (Tynn #756, PR9a): the registry, the settings, the flow store, the process
 * book, the trust verdict and the sites. Each is a thin mapping; the decisions are in `restoreClone` and the three restores under
 * it. Reads only what the restore asks, and nothing it is not allowed to change.
 */

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
    /** The flow store, or null while the host has not opened it. */
    readonly flows: () => Promise<{
        list(workspaceId?: string): readonly { name: string; workspaceId: string; document: unknown }[];
        create(input: { workspaceId: string; name: string; document: unknown; by: { kind: 'user' } }): Promise<unknown>;
    } | null>;
    /** The process book, or null while the host has not opened it. */
    readonly processes: () => Promise<{
        kept(): readonly { name: string; workspaceId: string; command: string; cwd: string; restart: ProcessSource['restart']; schedule?: ProcessSource['schedule'] }[];
        keep(input: KeepInput): Promise<unknown>;
    } | null>;
    trusted(workspaceId: string): boolean;
    siteHosts(workspaceId: string): readonly string[];
}

/** The real disk: a file's text or null, and the names in a folder. */
export function nodeCloneFiles(): CloneRestoreDeps['files'] {
    return {
        read: async (path) => { try { return await readFile(path, 'utf8'); } catch { return null; } },
        list: async (dir) => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name),
    };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function cloneRestorePorts(d: CloneRestoreDeps): CloneRestorePorts {
    return {
        files: d.files,
        settings: {
            agentsOf: (id) => d.registry.agentsOf(id),
            overridden: (id) => d.settings.workspaceValues(id),
            setSetting: (id, key, value) => d.settings.setFor(id, key, value),
            defaultAgentOf: (id) => d.registry.defaultAgentOf(id),
            setDefaultAgent: (id, agentId) => d.registry.setDefaultAgent(id, agentId),
            envFileOf: (id) => d.registry.listWorkspaces().find((w) => w.id === id)?.envFile ?? null,
            defaultEnvFile: () => text(d.settings.get('default_env_file')).trim() || '.env',
            setEnvFile: (id, file) => d.registry.setWorkspaceEnvFile(id, file),
            mcpOff: (id) => d.registry.workspaceMcpOff(id),
            setMcpServer: (id, name, on) => d.registry.setWorkspaceMcpServer(id, name, on),
        },
        tabs: {
            values: (id) => {
                const v = d.settings.workspaceValues(id);
                return { tabs: text(v.workspace_tabs), panelSplits: text(v.panel_splits), panelLayout: text(v.panel_layout) };
            },
            overridden: (id) => d.settings.workspaceValues(id),
            write: (id, key, value) => d.settings.setFor(id, key, value),
            siteHosts: (id) => d.siteHosts(id),
        },
        flows: async () => {
            const store = await d.flows();
            if (store === null) return null;
            return {
                list: (id) => store.list(id).filter((f) => f.workspaceId === id).map((f) => ({ name: f.name, document: f.document })),
                create: (input) => store.create({ workspaceId: input.workspaceId, name: input.name, document: input.document, by: input.by }),
            };
        },
        processes: async () => {
            const book = await d.processes();
            if (book === null) return null;
            return {
                list: (id) => book.kept().filter((p) => p.workspaceId === id).map((p) => ({ name: p.name, workspaceId: p.workspaceId, command: p.command, cwd: p.cwd, restart: p.restart, ...(p.schedule ? { schedule: p.schedule } : {}) })),
                keep: (input) => book.keep(input),
                agentAddressOf: (id, name) => {
                    const record = d.registry.listAgents().find((a) => a.workspaceId === id && a.name.toLowerCase() === name.toLowerCase());
                    return record ? agentAddress(record, d.registry.workspaceSlugs()) : null;
                },
            };
        },
        trusted: (id) => d.trusted(id),
    };
}
