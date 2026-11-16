import type { FlowPorts, FlowRestore } from './workspace-flows-host.js';
import type { ProcessPorts, ProcessRestore } from './workspace-processes-host.js';
import type { RestorePorts, SettingsRestore } from './workspace-restore-host.js';

/** Inert stubs (RED): opening a fresh clone, in order (Tynn #756, PR9a). The implementation lands after the tests are seen failing. */

export interface CloneRestorePorts {
    readonly files: { read(path: string): Promise<string | null>; list(dir: string): Promise<string[]> };
    readonly settings: RestorePorts;
    readonly tabs: {
        values(workspaceId: string): { tabs: string; panelSplits: string; panelLayout: string };
        overridden(workspaceId: string): Readonly<Record<string, unknown>>;
        write(workspaceId: string, key: 'workspace_tabs' | 'panel_splits' | 'panel_layout', value: string): Promise<unknown>;
        siteHosts(workspaceId: string): readonly string[];
    };
    flows: () => Promise<FlowPorts | null>;
    processes: () => Promise<ProcessPorts | null>;
    trusted(workspaceId: string): boolean;
}

export interface TabsRestoreReport {
    readonly added: string[];
    readonly present: string[];
    readonly differs: string[];
    readonly wrote: string[];
    readonly notes: string[];
}

export interface CloneRestore {
    readonly order: string[];
    readonly settings: SettingsRestore | null;
    readonly tabs: TabsRestoreReport | null;
    readonly trusted: boolean;
    readonly flows: FlowRestore | null;
    readonly processes: ProcessRestore | null;
    readonly skipped: { step: string; reason: string }[];
}

export async function restoreClone(_workspace: { id: string; path: string }, _ports: CloneRestorePorts): Promise<CloneRestore> {
    return { order: [], settings: null, tabs: null, trusted: false, flows: null, processes: null, skipped: [] };
}

export function watchNewWorkspaces(_registry: { workspaceStates(): readonly { id: string; asleep?: boolean }[]; subscribe(listener: () => void): () => void }, _onNew: (workspaceId: string) => void): () => void {
    return () => {};
}
