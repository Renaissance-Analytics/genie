import type { GitStatusMap, TerminalSpec, TreeNodeData } from './genie';
import type { WorkspaceChange } from './workspace-changes';

export interface SessionFileChange {
    path: string;
    who: string | null;
    agentId: string | null;
    at: number;
}

export async function popFilePanel(ports: { persist: () => Promise<void>; pop: () => Promise<void> }): Promise<void> {
    await ports.persist();
    await ports.pop();
}

export function changedFilePaths(changes: SessionFileChange[], gitStatus: GitStatusMap): Set<string> {
    return new Set([...changes.map((change) => change.path), ...Object.keys(gitStatus).filter((path) => gitStatus[path] !== 'ignored')]);
}

export function sessionFileChanges(
    reported: WorkspaceChange[],
    observed: Record<string, number>,
): SessionFileChange[] {
    const latest = new Map<string, SessionFileChange>(reported.map((row) => [row.path, row]));
    for (const [path, at] of Object.entries(observed)) {
        if ((latest.get(path)?.at ?? -1) < at) latest.set(path, { path, at, who: null, agentId: null });
    }
    return [...latest.values()].sort((first, second) => second.at - first.at);
}

export function filterChangedTree(nodes: TreeNodeData[], paths: Set<string>): TreeNodeData[] {
    return nodes.flatMap((node) => {
        if (node.type !== 'folder') return paths.has(node.id) ? [node] : [];
        const children = filterChangedTree(node.children ?? [], paths);
        return children.length ? [{ ...node, children }] : [];
    });
}

export function filePanelForWorkspace(specs: TerminalSpec[], workspaceId: string): TerminalSpec | null {
    return specs.find((spec) => spec.type === 'code' && (
        spec.workspace_id === workspaceId ||
        (workspaceId === '__system__' && spec.workspace_id === null && spec.meta?.system === true)
    )) ?? null;
}

export function uniqueWorkspaceFilePanels(specs: TerminalSpec[]): TerminalSpec[] {
    const seen = new Set<string>();
    return specs.filter((spec) => {
        if (spec.type !== 'code') return true;
        const workspaceId = spec.workspace_id ?? (spec.meta?.system ? '__system__' : spec.id);
        if (seen.has(workspaceId)) return false;
        seen.add(workspaceId);
        return true;
    });
}
