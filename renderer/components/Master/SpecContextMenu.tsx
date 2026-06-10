import { useEffect, useRef, type ReactNode } from 'react';
import {
    IconBox,
    IconChevronDown,
    IconCpu,
    IconGlobe,
    IconMaximize,
    IconPlus,
    IconTerminal,
    IconTrash,
} from './icons';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';

interface Position {
    x: number;
    y: number;
}

interface Props {
    position: Position;
    spec: TerminalSpec;
    inSelection: boolean;
    workspaces: WorkspaceRow[];
    onClose: () => void;
    onToggleInView: () => void;
    onOpenInNewWindow: () => void;
    onRename: () => void;
    onDuplicate: () => void;
    onMoveToWorkspace: (workspaceId: string | null) => void;
    onDelete: () => void;
}

/**
 * Right-click context menu for a terminal spec. Positioned at the
 * user's cursor; clamps to viewport so the menu doesn't overflow off
 * the right/bottom edges. Closes on outside-click or Escape.
 *
 * Items grouped by destructiveness — view/edit operations first, then
 * move/duplicate, then the destructive delete (separator + red tint).
 */
export default function SpecContextMenu({
    position,
    spec,
    inSelection,
    workspaces,
    onClose,
    onToggleInView,
    onOpenInNewWindow,
    onRename,
    onDuplicate,
    onMoveToWorkspace,
    onDelete,
}: Props) {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDocClick = (e: MouseEvent) => {
            if (!menuRef.current) return;
            if (e.target instanceof Node && !menuRef.current.contains(e.target)) {
                onClose();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    // After mount, clamp the menu position so it stays on screen even if
    // the right-click happened near the viewport edge.
    useEffect(() => {
        const el = menuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const margin = 8;
        let nx = position.x;
        let ny = position.y;
        if (nx + rect.width + margin > window.innerWidth) {
            nx = window.innerWidth - rect.width - margin;
        }
        if (ny + rect.height + margin > window.innerHeight) {
            ny = window.innerHeight - rect.height - margin;
        }
        el.style.left = `${Math.max(margin, nx)}px`;
        el.style.top = `${Math.max(margin, ny)}px`;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const otherWorkspaces = workspaces.filter((w) => w.id !== spec.workspace_id);

    return (
        <div
            ref={menuRef}
            className="proj-popover ctx-menu"
            role="menu"
            style={{ position: 'fixed', left: position.x, top: position.y }}
        >
            <div className="ctx-header">
                <span className="ctx-header-label">{spec.label}</span>
            </div>
            <div className="proj-popover-section">
                <CtxItem
                    icon={<IconChevronDown size={14} />}
                    label={inSelection ? 'Remove from view' : 'Add to view'}
                    onClick={() => {
                        onToggleInView();
                        onClose();
                    }}
                />
                <CtxItem
                    icon={<IconMaximize size={14} />}
                    label="Open in new window"
                    onClick={() => {
                        onOpenInNewWindow();
                        onClose();
                    }}
                />
            </div>

            <div className="proj-popover-divider" />

            <div className="proj-popover-section">
                <CtxItem
                    icon={<IconTerminal size={14} />}
                    label="Rename…"
                    onClick={() => {
                        onRename();
                        onClose();
                    }}
                />
                <CtxItem
                    icon={<IconPlus size={14} />}
                    label="Duplicate"
                    onClick={() => {
                        onDuplicate();
                        onClose();
                    }}
                />
            </div>

            {workspaces.length > 0 && (
                <>
                    <div className="proj-popover-divider" />
                    <div className="proj-popover-section">
                        <div className="proj-popover-header">Move to project</div>
                        {otherWorkspaces.map((w) => (
                            <CtxItem
                                key={w.id}
                                icon={workspaceIcon(w, 14)}
                                label={w.project_name}
                                onClick={() => {
                                    onMoveToWorkspace(w.id);
                                    onClose();
                                }}
                            />
                        ))}
                        {spec.workspace_id && (
                            <CtxItem
                                icon={<IconBox size={14} />}
                                label="Detach (no project)"
                                onClick={() => {
                                    onMoveToWorkspace(null);
                                    onClose();
                                }}
                            />
                        )}
                    </div>
                </>
            )}

            <div className="proj-popover-divider" />

            <div className="proj-popover-section">
                <CtxItem
                    icon={<IconTrash size={14} />}
                    label="Delete terminal"
                    destructive
                    onClick={() => {
                        onDelete();
                        onClose();
                    }}
                />
            </div>
        </div>
    );
}

function CtxItem({
    icon,
    label,
    onClick,
    destructive,
}: {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    destructive?: boolean;
}) {
    return (
        <button
            type="button"
            className={`proj-popover-item${destructive ? ' is-destructive' : ''}`}
            onClick={onClick}
        >
            <span className="ico">{icon}</span>
            <span className="lbl">{label}</span>
        </button>
    );
}

function workspaceIcon(ws: WorkspaceRow, size = 14) {
    if (ws.backend === 'aionima') return <IconCpu size={size} />;
    if (ws.shape === 'agi') return <IconBox size={size} />;
    return <IconGlobe size={size} />;
}
