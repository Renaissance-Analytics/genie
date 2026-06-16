import { useEffect, useRef, type ReactNode } from 'react';
import {
    IconBox,
    IconCpu,
    IconGlobe,
    IconMaximize,
    IconPlus,
    IconTerminal,
    IconTrash,
} from './icons';
import type { WorkspaceRow } from '../../lib/genie';

interface Position {
    x: number;
    y: number;
}

interface Props {
    position: Position;
    workspace: WorkspaceRow;
    onClose: () => void;
    onAddTerminal: () => void;
    onOpenStage: () => void;
    onOpenInBrowser: () => void;
    onRemove: () => void;
}

/**
 * Right-click context menu for a workspace (project) node in the
 * chooser tree. The "Open in Stage" item is the headline — pops a
 * dedicated window for this project that can later cherry-pick
 * terminals from any other project.
 */
export default function ProjectContextMenu({
    position,
    workspace,
    onClose,
    onAddTerminal,
    onOpenStage,
    onOpenInBrowser,
    onRemove,
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

    return (
        <div
            ref={menuRef}
            className="proj-popover ctx-menu"
            role="menu"
            style={{ position: 'fixed', left: position.x, top: position.y }}
        >
            <div className="ctx-header">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {workspaceIcon(workspace, 14)}
                    <span className="ctx-header-label">{workspace.project_name}</span>
                </span>
            </div>

            <div className="proj-popover-section">
                <CtxItem
                    icon={<IconMaximize size={14} />}
                    label="Open in Stage"
                    onClick={() => {
                        onOpenStage();
                        onClose();
                    }}
                />
                <CtxItem
                    icon={<IconPlus size={14} />}
                    label="Add Terminal"
                    onClick={() => {
                        onAddTerminal();
                        onClose();
                    }}
                />
                <CtxItem
                    icon={<IconGlobe size={14} />}
                    label="Open project in browser"
                    onClick={() => {
                        onOpenInBrowser();
                        onClose();
                    }}
                />
            </div>

            <div className="proj-popover-divider" />

            <div className="proj-popover-section">
                <CtxItem
                    icon={<IconTrash size={14} />}
                    label="Remove from Genie"
                    destructive
                    onClick={() => {
                        onRemove();
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

// Suppress unused-import lint; IconTerminal is used by sibling menus and
// kept available here so the file's icon vocabulary stays consistent.
void IconTerminal;
