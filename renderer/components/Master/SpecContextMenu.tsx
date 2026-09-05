import { useEffect, useRef, type ReactNode } from 'react';
import {
    IconBox,
    IconChevronDown,
    IconCpu,
    IconGlobe,
    IconMaximize,
    IconPlus,
    IconRefresh,
    IconSettings,
    IconTerminal,
    IconTrash,
} from './icons';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';
import { restartOptionsFor, type RestartMode } from '../../../main/agents/restart-options';
import { clampPopoverToViewport } from '../../lib/anchored-popover';

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
    /** Edit a specialized (agent) terminal's AgentInbox purpose/scope. Only
     *  offered when this spec is an agent terminal (`meta.agent` set). */
    onAgentSettings?: () => void;
    /** Restart an agent terminal so its TUI reconnects to the current MCP rig
     *  (fresh tools). TWO operations, and the item the user picks says which:
     *
     *  - `'resume'` continues the conversation. Offered only where the registry
     *    says the provider can (`TuiDef.resume` — the same table
     *    `renderAgentResume` builds the command from) AND a session was
     *    captured, so the item appears exactly where the restart would succeed.
     *  - `'fresh'` relaunches from scratch. Offered for EVERY agent terminal,
     *    because a wedged or dead one is the case that needs it most and was the
     *    case the old single gate excluded (genie#443). */
    onRestartAgent?: (mode: RestartMode) => void;
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
    onAgentSettings,
    onRestartAgent,
}: Props) {
    const isAgent = !!spec.meta?.agent;
    // WHICH restarts this terminal can be offered — asked of the same resolver
    // the host reasons with, so the menu cannot disagree with the main side.
    //
    // It did disagree, twice. This started as `spec.meta?.agent === 'claude'`
    // under a comment claiming codex had no resume; codex has rendered
    // `codex resume <id>` all along, so a codex agent was refused a restart that
    // works. Adding `|| === 'codex'` would have been the same bug with one more
    // literal, stale again the next time a provider learns to resume (genie#261).
    //
    // Then it became `canResumeTui(...)` — right about resuming, and used to gate
    // RESTARTING. A provider with `resume: null` lost the option entirely, so a
    // dead Genie TUI could not be recovered from this menu at all (genie#443).
    // Two questions, two items; `restartOptionsFor` answers both.
    const restartOptions = restartOptionsFor(spec);
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
                {/* NO "Duplicate". This product does not duplicate terminals or
                    agents — the item offered an operation that has no meaning
                    here, and on a running agent it sat one row above Delete. */}
                {isAgent && onAgentSettings && (
                    <CtxItem
                        icon={<IconSettings size={14} />}
                        label="Agent settings…"
                        onClick={() => {
                            onAgentSettings();
                            onClose();
                        }}
                    />
                )}
                {restartOptions.canResume && onRestartAgent && (
                    <CtxItem
                        icon={<IconRefresh size={14} />}
                        label="Restart agent (resume)"
                        onClick={() => {
                            onRestartAgent('resume');
                            onClose();
                        }}
                    />
                )}
                {restartOptions.canRestartFresh && onRestartAgent && (
                    <CtxItem
                        icon={<IconRefresh size={14} />}
                        label="Restart agent (fresh)"
                        onClick={() => {
                            onRestartAgent('fresh');
                            onClose();
                        }}
                    />
                )}
            </div>

            {/* NO "Move to project" and no "Detach (no project)". Agents are
                not moved between projects, and terminals are not detached from
                them — the entire section described operations this product does
                not do. */}

            <div className="proj-popover-divider" />

            <div className="proj-popover-section">
                <CtxItem
                    icon={<IconTrash size={14} />}
                    // An agent is not its terminal. Deleting one from an
                    // agent's menu removes the AGENT, and saying "terminal"
                    // there reads as "just close the shell". A plain terminal
                    // is still a terminal — renaming both would be the same
                    // error mirrored.
                    label={isAgent ? 'Delete agent' : 'Delete terminal'}
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
