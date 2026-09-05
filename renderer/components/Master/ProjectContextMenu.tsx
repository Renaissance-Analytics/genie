import { useEffect, useRef, type ReactNode } from 'react';
import {
    IconBox,
    IconCpu,
    IconGlobe,
    IconMaximize,
    IconMessage,
    IconPlus,
    IconServer,
    IconSettings,
    IconTerminal,
    IconTrash,
} from './icons';
import type { WorkspaceRow } from '../../lib/genie';
import { clampPopoverToViewport } from '../../lib/anchored-popover';

interface Position {
    x: number;
    y: number;
}

interface Props {
    position: Position;
    workspace: WorkspaceRow;
    onClose: () => void;
    onAddTerminal: () => void;
    onNewAgent: () => void;
    onOpenStage: () => void;
    onOpenInBrowser: () => void;
    onSettings: () => void;
    /** Open the Workspace Site Manager (#232). Absent in a remote window, where
     *  hosting drives the CLIENT's runtime rather than the host's. */
    onSiteManager?: () => void;
    /** Send feedback about GENIE to this workspace's Tynn project (Tynn #249). */
    onFeedback?: () => void;
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
    onNewAgent,
    onOpenStage,
    onOpenInBrowser,
    onSettings,
    onSiteManager,
    onFeedback,
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
        const { left, top } = clampPopoverToViewport({
            left: position.x,
            top: position.y,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
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
                {/* An AGENT, not a terminal. Creating one was MCP-only until now —
                    the form existed and was unreachable, because `panelLauncherTypes()`
                    filters out every specialized type. Right-clicking the workspace is
                    where a person looks for this. */}
                <CtxItem
                    icon={<IconPlus size={14} />}
                    label="New agent…"
                    onClick={() => {
                        onNewAgent();
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
                {/* The Site Manager is its OWN surface, not a settings section
                    (owner decision) — so it gets its own entry, above settings,
                    beside the other "do something with this workspace" items. */}
                {onSiteManager && (
                    <CtxItem
                        icon={<IconServer size={14} />}
                        label="Site Manager…"
                        onClick={() => {
                            onSiteManager();
                            onClose();
                        }}
                    />
                )}
                {/* Feedback about GENIE, not about the work — it goes to this
                    workspace's Tynn project, where it can be triaged or turned
                    into a wish. In-app rather than a link out: leaving Genie is
                    the friction that stops feedback being written at all. */}
                {onFeedback && (
                    <CtxItem
                        icon={<IconMessage size={14} />}
                        label="Send feedback…"
                        onClick={() => {
                            onFeedback();
                            onClose();
                        }}
                    />
                )}
                <CtxItem
                    icon={<IconSettings size={14} />}
                    label="Workspace settings…"
                    onClick={() => {
                        onSettings();
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
