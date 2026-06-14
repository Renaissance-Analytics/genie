import { useEffect, useRef, type ReactNode } from 'react';
import {
    IconBox,
    IconCode,
    IconCopy,
    IconListTree,
    IconPlus,
    IconTrash,
} from '../Master/icons';
import type { TreeNodeData } from '../../lib/genie';

interface Position {
    x: number;
    y: number;
}

interface Props {
    position: Position;
    /** The right-clicked node, or null for an empty-space (tree-root) menu. */
    node: TreeNodeData | null;
    onClose: () => void;
    onNewFile: () => void;
    onNewFolder: () => void;
    onRename: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onCopyPath: () => void;
}

/**
 * Right-click context menu for a Code View file-tree node. Mirrors
 * ProjectContextMenu's chrome (`.proj-popover.ctx-menu`) for consistency.
 *
 * New File / New Folder always show (they create inside a folder, beside a
 * file, or at the tree root for an empty-space click). Rename / Delete /
 * Copy relative path require a concrete node, so they're hidden on the
 * empty-space menu.
 */
export default function FileTreeContextMenu({
    position,
    node,
    onClose,
    onNewFile,
    onNewFolder,
    onRename,
    onDuplicate,
    onDelete,
    onCopyPath,
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

    // Clamp to the viewport so a menu near the edge isn't cut off.
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

    const isFolder = node?.type === 'folder';
    const header = node ? node.label : 'Tree root';

    return (
        <div
            ref={menuRef}
            className="proj-popover ctx-menu"
            role="menu"
            style={{ position: 'fixed', left: position.x, top: position.y }}
        >
            <div className="ctx-header">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {node ? (
                        isFolder ? (
                            <IconBox size={14} />
                        ) : (
                            <IconCode size={14} />
                        )
                    ) : (
                        <IconListTree size={14} />
                    )}
                    <span className="ctx-header-label">{header}</span>
                </span>
            </div>

            <div className="proj-popover-section">
                <CtxItem
                    icon={<IconPlus size={14} />}
                    label="New file"
                    onClick={() => {
                        onNewFile();
                        onClose();
                    }}
                />
                <CtxItem
                    icon={<IconPlus size={14} />}
                    label="New folder"
                    onClick={() => {
                        onNewFolder();
                        onClose();
                    }}
                />
            </div>

            {node && (
                <>
                    <div className="proj-popover-divider" />
                    <div className="proj-popover-section">
                        <CtxItem
                            icon={<IconListTree size={14} />}
                            label="Copy relative path"
                            onClick={() => {
                                onCopyPath();
                                onClose();
                            }}
                        />
                        <CtxItem
                            icon={<IconCode size={14} />}
                            label="Rename"
                            onClick={() => {
                                onRename();
                                onClose();
                            }}
                        />
                        {!isFolder && (
                            <CtxItem
                                icon={<IconCopy size={14} />}
                                label="Duplicate"
                                onClick={() => {
                                    onDuplicate();
                                    onClose();
                                }}
                            />
                        )}
                        <CtxItem
                            icon={<IconTrash size={14} />}
                            label="Delete"
                            destructive
                            onClick={() => {
                                onDelete();
                                onClose();
                            }}
                        />
                    </div>
                </>
            )}
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
