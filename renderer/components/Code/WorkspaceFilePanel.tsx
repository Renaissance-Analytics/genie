import { useEffect, useState, type CSSProperties } from 'react';
import type { AgentSession } from '../../../main/agentsession/model';
import {
    api,
    currentConnKey,
    SYSTEM_WORKSPACE_ID,
    type TerminalSpec,
    type WorkspaceRow,
} from '../../lib/genie';
import { filePanelSlot, singlePoppedPanel } from '../../lib/file-panel-states';
import type { PanelDragHandlers } from '../../lib/panel-reorder';
import CodePanel from './CodePanel';
import { FilePanelStandIn } from './FilePanelStates';

/**
 * THE WORKSPACE FILE PANEL'S SLOT — the real panel, or what stands in for it.
 *
 * One panel per workspace (§5.3), and it can be somewhere other than here: in its own window,
 * in another master window, or dismissed with ⌘B. Which of those it is, `filePanelSlot` decides
 * and `FilePanelStandIn` draws; this component is the part that cannot be unit-tested — the
 * ownership claim, the popped-window list, and the subscription that keeps both current.
 *
 * It exists as its own component for exactly that reason. The same logic inline in a grid tile
 * put `popped || owned !== true` and a bring-back button in one JSX expression, where the rule
 * that a window you did NOT pop is not yours to reel in has to be re-derived by eye every time
 * the markup changes. Here the rule arrives as `slot.canBringBack`, decided once and tested.
 */
export default function WorkspaceFilePanel({
    spec,
    workspace,
    sessions = [],
    closed = false,
    onClose,
    onDirtyChange,
    onMaximize,
    onMinimize,
    focused,
    attention,
    maximized,
    style,
    drag,
}: {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
    sessions?: AgentSession[];
    /** ⌘B dismissed the panel: the slot stays, empty, and carries no bar. */
    closed?: boolean;
    onClose: () => void;
    onDirtyChange?: (dirty: boolean) => void;
    onMaximize?: () => void;
    onMinimize?: () => void;
    focused?: boolean;
    attention?: boolean;
    maximized?: boolean;
    style?: CSSProperties;
    drag?: PanelDragHandlers;
}) {
    const workspaceId = spec.workspace_id ?? (spec.meta?.system ? SYSTEM_WORKSPACE_ID : null);
    /**
     * Whether THIS window can hold the local panel's claim.
     *
     * `typeof window` is part of it, and for `filePanelSlot`'s own stated reason: *"A remote
     * one never claims the local panel, so it must not wait on a claim that will never
     * arrive."* A DOM-less render (the component tests, which have no jsdom) can make no claim
     * at all, so it must not sit on `opening` either — it renders the panel, exactly as the
     * grid's `typeof window !== 'undefined'` guard did before this component existed.
     */
    const local = typeof window !== 'undefined' && currentConnKey() === 'local';
    const [owned, setOwned] = useState<boolean | null>(null);
    const [poppedPanels, setPoppedPanels] = useState<Array<{ workspaceId: string; specId: string }>>([]);

    // The popped-window list, and the event that announces every change to it. Read even when
    // nothing is popped: `[]` is the measurement that says so, and the slot needs to tell it
    // apart from not having asked yet.
    useEffect(() => {
        if (!local) return;
        let alive = true;
        const read = () => void api().files.poppedPanels().then((panels) => {
            if (alive) setPoppedPanels(panels);
        }).catch(() => {});
        const off = api().on.filePanelWindowsChanged(read);
        read();
        return () => {
            alive = false;
            off();
        };
    }, [local]);

    // Claim the panel for THIS window. A window that does not hold the claim must not render an
    // editor over the same files — two editors with independent dirty buffers is how an unsaved
    // edit gets overwritten by the other one's save.
    const popped = workspaceId !== null && singlePoppedPanel(poppedPanels, workspaceId).specId !== null;
    useEffect(() => {
        if (!workspaceId || !local) return;
        if (popped) {
            setOwned(false);
            return;
        }
        let alive = true;
        const claim = () => void api().files.claimPanel(spec.id).then((ok) => {
            if (alive) setOwned(ok);
        }).catch(() => {
            if (alive) setOwned(false);
        });
        const off = api().on.filePanelWindowsChanged(claim);
        claim();
        return () => {
            alive = false;
            off();
            void api().files.releasePanel(workspaceId);
        };
    }, [spec.id, workspaceId, local, popped]);

    const one = workspaceId === null ? { specId: null, duplicates: 0 } : singlePoppedPanel(poppedPanels, workspaceId);
    const slot = filePanelSlot({ popped, owned, closed, local });
    if (slot.kind !== 'panel') {
        return (
            <FilePanelStandIn
                slot={slot}
                duplicates={one.duplicates}
                workspaceName={workspace?.project_name ?? spec.label}
                onFocusWindow={() => { if (workspaceId) void api().files.focusPanel(workspaceId); }}
                onBringBack={() => { if (workspaceId) void api().files.bringBackPanel(workspaceId); }}
                onClose={onClose}
            />
        );
    }
    return (
        <CodePanel
            spec={spec}
            workspace={workspace}
            sessions={sessions}
            onPopOut={workspaceId && local ? async () => {
                const result = await api().files.popPanel(spec.id);
                if (!result.ok) throw new Error(result.error ?? 'Could not open the file panel window.');
            } : undefined}
            onDirtyChange={onDirtyChange}
            onClose={onClose}
            onMaximize={onMaximize}
            onMinimize={onMinimize}
            focused={focused}
            attention={attention}
            maximized={maximized}
            style={style}
            drag={drag}
        />
    );
}
