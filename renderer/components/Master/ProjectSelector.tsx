import { useEffect, useRef, useState } from 'react';
import { IconBox, IconChevronDown, IconCpu, IconGlobe } from './icons';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';

interface Props {
    workspaces: WorkspaceRow[];
    specs: TerminalSpec[];
    selected: Set<string>;
    workspacesById: Map<string, WorkspaceRow>;
    onSwitchToProject: (workspaceId: string) => void;
    onShowAll: () => void;
    onClear: () => void;
}

/**
 * Toolbar project selector — opens a popover listing every registered
 * workspace plus a few cross-project shortcuts. The selector reflects
 * the *current* selection: "Mixed" when more than one project has live
 * panels, the single project name when only one does, "Nothing
 * selected" otherwise. Clicking the items:
 *
 *   - a workspace → replaces the current selection with every spec
 *     attached to that workspace (the "switch to this project" path).
 *   - Show every terminal → selects every spec across every workspace.
 *   - Clear selection → empties the grid.
 *
 * Closes on outside-click or Escape. Single instance per master view.
 */
export default function ProjectSelector({
    workspaces,
    specs,
    selected,
    workspacesById,
    onSwitchToProject,
    onShowAll,
    onClear,
}: Props) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
            if (!rootRef.current) return;
            if (e.target instanceof Node && !rootRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    // Group selection counts per workspace for the popover badges.
    const selectedByWorkspace = new Map<string, number>();
    let orphaned = 0;
    for (const s of specs) {
        if (!selected.has(s.id)) continue;
        if (s.workspace_id && workspacesById.has(s.workspace_id)) {
            selectedByWorkspace.set(
                s.workspace_id,
                (selectedByWorkspace.get(s.workspace_id) ?? 0) + 1,
            );
        } else {
            orphaned++;
        }
    }

    const activeProjects = [...selectedByWorkspace.keys()].map((id) =>
        workspacesById.get(id),
    );
    let label = 'Nothing selected';
    let hint = '';
    if (activeProjects.length === 1) {
        label = activeProjects[0]?.project_name ?? '—';
        hint = 'single project';
    } else if (activeProjects.length > 1) {
        label = 'Mixed';
        hint = activeProjects.map((p) => p?.project_name ?? '—').join(' · ');
    }

    return (
        <div className="proj-select-wrap" ref={rootRef}>
            <button
                type="button"
                className="proj-select"
                onClick={() => setOpen((v) => !v)}
                title="Switch project"
            >
                {activeProjects.length > 1 ? (
                    <span className="picons">
                        {activeProjects.slice(0, 2).map((p, i) => (
                            <span key={i}>{workspaceIcon(p, 12)}</span>
                        ))}
                    </span>
                ) : (
                    <span style={{ display: 'inline-flex', color: 'var(--fg-3)' }}>
                        {workspaceIcon(activeProjects[0], 12)}
                    </span>
                )}
                <span className="pname">{label}</span>
                {activeProjects.length > 1 && (
                    <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                        {activeProjects.length} projects
                    </span>
                )}
                <span className="chev">
                    <IconChevronDown />
                </span>
            </button>

            {hint && <span className="hint">{hint}</span>}

            {open && (
                <div className="proj-popover" role="menu">
                    <div className="proj-popover-section">
                        <button
                            type="button"
                            className="proj-popover-item"
                            onClick={() => {
                                onShowAll();
                                setOpen(false);
                            }}
                        >
                            <span className="ico">
                                <IconBox size={14} />
                            </span>
                            <span className="lbl">Show every terminal</span>
                            <span className="sub">{specs.length}</span>
                        </button>
                        <button
                            type="button"
                            className="proj-popover-item"
                            onClick={() => {
                                onClear();
                                setOpen(false);
                            }}
                            disabled={selected.size === 0}
                        >
                            <span className="ico">
                                <IconChevronDown size={14} />
                            </span>
                            <span className="lbl">Clear selection</span>
                            <span className="sub">{selected.size}</span>
                        </button>
                    </div>

                    <div className="proj-popover-divider" />

                    <div className="proj-popover-section">
                        <div className="proj-popover-header">Projects</div>
                        {workspaces.length === 0 && (
                            <div className="proj-popover-empty">
                                No workspaces registered yet.
                            </div>
                        )}
                        {workspaces.map((ws) => {
                            const live = selectedByWorkspace.get(ws.id) ?? 0;
                            return (
                                <button
                                    key={ws.id}
                                    type="button"
                                    className={`proj-popover-item${
                                        live > 0 ? ' is-active' : ''
                                    }`}
                                    onClick={() => {
                                        onSwitchToProject(ws.id);
                                        setOpen(false);
                                    }}
                                >
                                    <span className="ico">
                                        {workspaceIcon(ws, 14)}
                                    </span>
                                    <span className="lbl">{ws.project_name}</span>
                                    {live > 0 && <span className="sub">{live}</span>}
                                </button>
                            );
                        })}
                        {orphaned > 0 && (
                            <div className="proj-popover-empty">
                                + {orphaned} unattached terminal
                                {orphaned === 1 ? '' : 's'} in tree
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function workspaceIcon(ws: WorkspaceRow | undefined, size = 14) {
    if (!ws) return <IconBox size={size} />;
    if (ws.backend === 'aionima') return <IconCpu size={size} />;
    if (ws.shape === 'agi') return <IconBox size={size} />;
    return <IconGlobe size={size} />;
}
