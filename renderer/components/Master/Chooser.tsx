import { useState } from 'react';
import {
    IconBox,
    IconCheck,
    IconChevronDown,
    IconCpu,
    IconGlobe,
    IconPanelLeftOpen,
    IconPin,
    IconPlus,
    IconSearch,
    IconTerminal,
    IconTrash,
} from './icons';
import { showPrompt } from './Prompt';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';

interface Props {
    workspaces: WorkspaceRow[];
    specs: TerminalSpec[];
    selected: Set<string>;
    activeIds: Set<string>;
    pinned: boolean;
    onTogglePin: () => void;
    onToggleSpec: (id: string) => void;
    onAddSpec: (workspaceId: string) => void;
    onDestroySpec: (id: string) => void;
    onOpenContextMenu: (specId: string, position: { x: number; y: number }) => void;
    onOpenProjectMenu: (workspaceId: string, position: { x: number; y: number }) => void;
    onAddWorkspace: () => void;
}

/**
 * Left chooser: 56px icon rail (always visible) + a 282px flyout that
 * either hovers in or stays pinned to the side. Tree groups terminal
 * specs by workspace. The icon rail also shows aggregate counts per
 * workspace so you can navigate without expanding the flyout.
 */
export default function Chooser({
    workspaces,
    specs,
    selected,
    activeIds,
    pinned,
    onTogglePin,
    onToggleSpec,
    onAddSpec,
    onDestroySpec,
    onOpenContextMenu,
    onOpenProjectMenu,
    onAddWorkspace,
}: Props) {
    const [search, setSearch] = useState('');
    const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
        () => new Set(),
    );

    const byWorkspace = new Map<string, TerminalSpec[]>();
    for (const ws of workspaces) byWorkspace.set(ws.id, []);
    const orphaned: TerminalSpec[] = [];
    for (const s of specs) {
        if (s.workspace_id && byWorkspace.has(s.workspace_id)) {
            byWorkspace.get(s.workspace_id)!.push(s);
        } else {
            orphaned.push(s);
        }
    }

    const matches = (s: TerminalSpec): boolean => {
        if (!search) return true;
        const q = search.toLowerCase();
        return s.label.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q);
    };

    return (
        <div className={`chooser${pinned ? ' pinned' : ''}`}>
            <aside className="chooser-rail">
                <button
                    type="button"
                    className="crail-toggle"
                    onClick={onTogglePin}
                    title={pinned ? 'Unpin terminals panel' : 'Pin terminals panel'}
                >
                    {pinned ? <IconPin size={18} /> : <IconPanelLeftOpen size={18} />}
                </button>
                <span className="crail-sep" />
                {workspaces.map((ws) => {
                    const wsSpecs = byWorkspace.get(ws.id) ?? [];
                    const live = wsSpecs.filter((s) => activeIds.has(s.id)).length;
                    return (
                        <button
                            key={ws.id}
                            type="button"
                            className={`crail-btn${live > 0 ? ' active' : ''}`}
                            title={`${ws.project_name}${live > 0 ? ` · ${live} live` : ''}`}
                        >
                            {workspaceIcon(ws)}
                            {live > 0 && <span className="cnt">{live}</span>}
                        </button>
                    );
                })}
                <span className="crail-sep" />
                <button
                    type="button"
                    className="crail-btn"
                    title="Add workspace"
                    onClick={onAddWorkspace}
                >
                    <IconPlus size={18} />
                </button>
            </aside>

            <aside className="chooser-flyout">
                <div className="rail-head">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span className="rt">Terminals</span>
                        <span className="rsub">Pick from any project</span>
                    </div>
                    <span className="grow" />
                    <button
                        type="button"
                        className="gicon flyout-pin"
                        onClick={onTogglePin}
                        title={pinned ? 'Unpin panel' : 'Pin open'}
                    >
                        <IconPin />
                    </button>
                </div>

                <div className="rail-search">
                    <IconSearch />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search terminals…"
                    />
                </div>

                <div className="rail-scroll">
                    <button
                        type="button"
                        className="tproj-add"
                        onClick={onAddWorkspace}
                    >
                        <IconPlus size={13} />
                        <span>Add workspace…</span>
                    </button>

                    {workspaces.length === 0 && (
                        <div
                            style={{
                                padding: '12px 8px',
                                fontSize: 12,
                                color: 'var(--fg-4)',
                                lineHeight: 1.5,
                            }}
                        >
                            No workspaces yet. Click <strong>Add workspace…</strong>{' '}
                            above to register a project folder.
                        </div>
                    )}

                    {workspaces.map((ws) => {
                        const wsSpecs = (byWorkspace.get(ws.id) ?? []).filter(matches);
                        const collapsed = collapsedWorkspaces.has(ws.id);
                        return (
                            <div
                                key={ws.id}
                                className={`tproj${collapsed ? ' collapsed' : ''}`}
                            >
                                <button
                                    type="button"
                                    className="tproj-head"
                                    onClick={() => {
                                        setCollapsedWorkspaces((prev) => {
                                            const next = new Set(prev);
                                            if (collapsed) next.delete(ws.id);
                                            else next.add(ws.id);
                                            return next;
                                        });
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        onOpenProjectMenu(ws.id, {
                                            x: e.clientX,
                                            y: e.clientY,
                                        });
                                    }}
                                >
                                    <span className="chev">
                                        <IconChevronDown />
                                    </span>
                                    <span className="pico">{workspaceIcon(ws, 14)}</span>
                                    <span className="pname">{ws.project_name}</span>
                                    <span className="pcount">{wsSpecs.length}</span>
                                </button>
                                <div className="tproj-body">
                                    {wsSpecs.map((s) => (
                                        <SpecRow
                                            key={s.id}
                                            spec={s}
                                            checked={selected.has(s.id)}
                                            live={activeIds.has(s.id)}
                                            hostKind={hostBadgeKind(ws.backend)}
                                            hostLabel={ws.backend}
                                            onToggle={() => onToggleSpec(s.id)}
                                            onDestroy={() => onDestroySpec(s.id)}
                                            onContextMenu={(p) =>
                                                onOpenContextMenu(s.id, p)
                                            }
                                        />
                                    ))}
                                    <button
                                        type="button"
                                        className="tterm"
                                        onClick={() => onAddSpec(ws.id)}
                                        style={{ color: 'var(--fg-4)' }}
                                    >
                                        <span className="pick" />
                                        <IconPlus size={12} />
                                        <span className="tname">Add terminal…</span>
                                    </button>
                                </div>
                            </div>
                        );
                    })}

                    {orphaned.length > 0 && (
                        <div className="tproj">
                            <div className="tproj-head">
                                <span className="chev">
                                    <IconChevronDown />
                                </span>
                                <span className="pico">
                                    <IconTerminal size={14} />
                                </span>
                                <span className="pname">Unattached</span>
                                <span className="pcount">{orphaned.length}</span>
                            </div>
                            <div className="tproj-body">
                                {orphaned.filter(matches).map((s) => (
                                    <SpecRow
                                        key={s.id}
                                        spec={s}
                                        checked={selected.has(s.id)}
                                        live={activeIds.has(s.id)}
                                        hostKind="desktop"
                                        hostLabel="local"
                                        onToggle={() => onToggleSpec(s.id)}
                                        onDestroy={() => onDestroySpec(s.id)}
                                        onContextMenu={(p) =>
                                            onOpenContextMenu(s.id, p)
                                        }
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </aside>
        </div>
    );
}

function workspaceIcon(ws: WorkspaceRow, size = 18) {
    if (ws.backend === 'aionima') return <IconCpu size={size} />;
    if (ws.shape === 'agi') return <IconBox size={size} />;
    return <IconGlobe size={size} />;
}

function hostBadgeKind(backend: WorkspaceRow['backend']): string {
    if (backend === 'aionima') return 'aionima';
    if (backend === 'tynn') return 'tynn';
    return 'desktop';
}

interface SpecRowProps {
    spec: TerminalSpec;
    checked: boolean;
    live: boolean;
    hostKind: string;
    hostLabel: string;
    onToggle: () => void;
    onDestroy: () => void;
    onContextMenu: (position: { x: number; y: number }) => void;
}

/**
 * One terminal row in the tree. The whole row is the toggle target; the
 * trash button on the right is a separate button that stops event
 * propagation so clicking it destroys the spec without also toggling
 * selection. A confirm guard fires for the destroy path because it
 * removes the spec from the DB and can't be undone.
 */
function SpecRow({
    spec,
    checked,
    live,
    hostKind,
    hostLabel,
    onToggle,
    onDestroy,
    onContextMenu,
}: SpecRowProps) {
    const handleDestroy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const ok = await showPrompt({
            title: 'Delete terminal',
            body: `Delete "${spec.label}"? Its saved spec is removed and any running shell is killed.`,
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (ok !== null) onDestroy();
    };
    return (
        <div
            className={`tterm${checked ? ' on sel' : ''}`}
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggle();
                }
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu({ x: e.clientX, y: e.clientY });
            }}
            style={{ cursor: 'pointer' }}
        >
            <span className="pick">{checked && <IconCheck size={11} />}</span>
            <span className={`sdot ${live ? 'run' : 'idle'}`} />
            <span className="tname">{spec.label}</span>
            <span className={`host ${hostKind}`}>{hostLabel}</span>
            <button
                type="button"
                className="tterm-trash"
                onClick={handleDestroy}
                title="Delete terminal"
                aria-label={`Delete ${spec.label}`}
            >
                <IconTrash size={13} />
            </button>
        </div>
    );
}
