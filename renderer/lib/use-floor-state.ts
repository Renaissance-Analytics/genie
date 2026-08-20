import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, hasGenieBridge, type TerminalSpec, type WorkspaceRow } from './genie';
import type { FloorState } from '../components/Master/Floor';
import type { LayoutMode } from '../components/Master/TerminalGrid';

/**
 * The Floor's state for ONE workspace (Tynn #250).
 *
 * A GApp window is a single workspace, which makes it the simpler half of what the
 * master window does. Most of master's floor machinery is about having MANY
 * workspaces — switching between them, keeping off-workspace panels mounted-hidden
 * so their ptys survive the switch, remembering per-workspace track sizes. None of
 * that exists here, because there is nothing to switch to.
 *
 * So the state is derived separately and the SURFACE is shared: both windows build
 * a {@link FloorState} and hand it to the same `<Floor />`. Forcing one state model
 * on both would mean carrying multi-workspace machinery into a window that has no
 * use for it, which is how a shared component becomes a shared liability.
 */
export function useFloorState(
    workspaceId: string | null,
    workspace: WorkspaceRow | null,
): FloorState {
    const [specs, setSpecs] = useState<TerminalSpec[]>([]);
    const [focusId, setFocusId] = useState<string | null>(null);
    const [maximizedId, setMaximizedId] = useState<string | null>(null);
    const [layoutMode] = useState<LayoutMode>('auto');
    const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());

    const refresh = useCallback(() => {
        if (!hasGenieBridge() || !workspaceId) return;
        api()
            .terminalSpec.list()
            .then((all) =>
                // A GApp's floor shows its OWN workspace and nothing else. Process
                // specs are background jobs, not panels — the same exclusion the
                // master window makes.
                setSpecs(all.filter((s) => s.workspace_id === workspaceId && s.type !== 'process')),
            )
            .catch(() => {});
    }, [workspaceId]);

    useEffect(() => {
        refresh();
        // Push-driven, like everything else: a spec created by an agent through MCP
        // has to appear here without the window being poked.
        return api().on.terminalSpecsChanged?.(refresh);
    }, [refresh]);

    const workspacesById = useMemo(
        () => new Map(workspace ? [[workspace.id, workspace]] : []),
        [workspace],
    );

    const addSpec = useCallback(
        async (type: 'terminal' | 'code') => {
            if (!workspaceId || !workspace) return;
            await api()
                .terminalSpec.create({
                    id: `gapp-${Math.random().toString(36).slice(2, 10)}`,
                    workspace_id: workspaceId,
                    label: type === 'code' ? 'Files' : 'Terminal',
                    cwd: workspace.path,
                    type,
                })
                .catch(() => null);
            refresh();
        },
        [workspaceId, workspace, refresh],
    );

    return {
        specs,
        workspacesById,
        activeWorkspaceId: workspaceId,
        focusId,
        // A GApp window has no cross-workspace attention to track: its panels are
        // in front of you whenever the window is.
        attentionIds: useMemo(() => new Set<string>(), []),
        maximizedId,
        onClose: (id) => {
            void api().terminalSpec.remove(id).then(refresh).catch(() => {});
        },
        onFocus: (id) => setFocusId((cur) => (cur === id ? null : id)),
        onToggleMaximize: (id) => setMaximizedId((cur) => (cur === id ? null : id)),
        onAddTerminal: () => void addSpec('terminal'),
        onAddCode: () => void addSpec('code'),
        onMarkActive: (id) => setActiveIds((cur) => new Set(cur).add(id)),
        onMarkInactive: (id) =>
            setActiveIds((cur) => {
                const next = new Set(cur);
                next.delete(id);
                return next;
            }),
        layoutMode,
        onReorder: (ids) => {
            void api().terminalSpec.reorder(ids).then(refresh).catch(() => {});
        },
        projectCount: workspace ? 1 : 0,
        activeCount: activeIds.size,
    };
}
