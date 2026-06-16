import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    IconAlert,
    IconBox,
    IconCheck,
    IconChevronDown,
    IconCode,
    IconCpu,
    IconGlobe,
    IconGrip,
    IconPanelLeftOpen,
    IconPause,
    IconPin,
    IconPlay,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconTerminal,
    IconTrash,
} from './icons';
import { showPrompt } from './Prompt';
import {
    api,
    type McpStatus,
    type ProcessStatus,
    type StructureDocStatus,
    type TerminalSpec,
    type ViewType,
    type WorkspaceRow,
} from '../../lib/genie';

interface Props {
    workspaces: WorkspaceRow[];
    specs: TerminalSpec[];
    selected: Set<string>;
    activeIds: Set<string>;
    /** Agent-integration MCP: terminals pulsing for attention (imDone). */
    attentionIds: Set<string>;
    activeWorkspaceId: string | null;
    pinned: boolean;
    onTogglePin: () => void;
    onActivateWorkspace: (workspaceId: string) => void;
    onToggleSpec: (id: string) => void;
    onAddSpec: (workspaceId: string, type: ViewType) => void;
    onDestroySpec: (id: string) => void;
    /** Tier 2: suspend a terminal (keep pty, hide panel). */
    onDisableSpec: (id: string) => void;
    /** Tier 2: resume a suspended terminal (reattach to the live session). */
    onEnableSpec: (id: string) => void;
    onOpenContextMenu: (specId: string, position: { x: number; y: number }) => void;
    onOpenProjectMenu: (workspaceId: string, position: { x: number; y: number }) => void;
    onAddWorkspace: () => void;
    /** Persist a new sidebar order (full ordered list of workspace ids). */
    onReorderWorkspaces: (ids: string[]) => void;
    /** Create a Process (background service runner) for a workspace. */
    onAddProcess: (workspaceId: string, command: string, label?: string) => void;
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
    attentionIds,
    activeWorkspaceId,
    pinned,
    onTogglePin,
    onActivateWorkspace,
    onToggleSpec,
    onAddSpec,
    onDestroySpec,
    onDisableSpec,
    onEnableSpec,
    onOpenContextMenu,
    onOpenProjectMenu,
    onAddWorkspace,
    onReorderWorkspaces,
    onAddProcess,
}: Props) {
    const promptAddProcess = async (workspaceId: string) => {
        const command = await showPrompt({
            title: 'New process',
            label: 'Command',
            placeholder: 'php artisan queue:work',
            confirmLabel: 'Create',
        });
        if (command && command.trim()) onAddProcess(workspaceId, command.trim());
    };

    const [search, setSearch] = useState('');
    const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
        () => new Set(),
    );

    // Drag-to-reorder (flyout only). `dragOrder` is a live preview of the id
    // order while a drag is in flight; the rail + flyout both render from it
    // so the rail "updates based on the flyout". Committed on drop.
    const [dragOrder, setDragOrder] = useState<string[] | null>(null);
    const draggingId = useRef<string | null>(null);

    const orderedWorkspaces = dragOrder
        ? (dragOrder
              .map((id) => workspaces.find((w) => w.id === id))
              .filter((w): w is WorkspaceRow => !!w))
        : workspaces;

    const reorderPreview = (overId: string) => {
        const id = draggingId.current;
        if (!id || id === overId) return;
        setDragOrder((cur) => {
            const list = cur ?? workspaces.map((w) => w.id);
            const from = list.indexOf(id);
            const to = list.indexOf(overId);
            if (from === -1 || to === -1 || from === to) return list;
            const next = [...list];
            next.splice(from, 1);
            next.splice(to, 0, id);
            return next;
        });
    };

    const commitReorder = () => {
        const list = dragOrder;
        draggingId.current = null;
        setDragOrder(null);
        if (list) onReorderWorkspaces(list);
    };

    // Background-process status (the headless supervisor in main is the source
    // of truth). The workspace-row indicator + the inline manager read from
    // this; processes keep running regardless of whether a row is expanded.
    const [processStatus, setProcessStatus] = useState<
        Map<string, ProcessStatus>
    >(() => new Map());
    const [expandedProcs, setExpandedProcs] = useState<Set<string>>(
        () => new Set(),
    );

    useEffect(() => {
        let alive = true;
        void api()
            .process.statuses()
            .then((m) => {
                if (alive)
                    setProcessStatus(
                        new Map(Object.entries(m) as [string, ProcessStatus][]),
                    );
            })
            .catch(() => {});
        const off = api().on.processStatus(({ id, status }) =>
            setProcessStatus((prev) => {
                const next = new Map(prev);
                next.set(id, status);
                return next;
            }),
        );
        return () => {
            alive = false;
            off();
        };
    }, []);

    const toggleProcs = (wsId: string) =>
        setExpandedProcs((prev) => {
            const next = new Set(prev);
            if (next.has(wsId)) next.delete(wsId);
            else next.add(wsId);
            return next;
        });

    /** Aggregate a workspace's process statuses into the row indicator colour. */
    const wsProcStatus = (
        procSpecs: TerminalSpec[],
    ): 'none' | 'idle' | 'running' | 'crashed' => {
        if (!procSpecs.length) return 'none';
        let running = false;
        for (const s of procSpecs) {
            const st = processStatus.get(s.id) ?? 'stopped';
            if (st === 'crashed' || st === 'failed') return 'crashed';
            if (st === 'running' || st === 'restarting') running = true;
        }
        return running ? 'running' : 'idle';
    };

    const deleteProcess = async (s: TerminalSpec) => {
        const ok = await showPrompt({
            title: 'Delete process',
            body: `Delete "${s.label}"? It will be stopped and removed.`,
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (ok !== null) onDestroySpec(s.id);
    };

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
                {orderedWorkspaces.map((ws) => {
                    const wsSpecs = byWorkspace.get(ws.id) ?? [];
                    const live = wsSpecs.filter((s) => activeIds.has(s.id)).length;
                    const wsAttention = wsSpecs.some((s) => attentionIds.has(s.id));
                    const isActive = ws.id === activeWorkspaceId;
                    return (
                        <button
                            key={ws.id}
                            type="button"
                            className={`crail-btn${live > 0 ? ' active' : ''}${
                                isActive ? ' is-active' : ''
                            }${wsAttention ? ' attention' : ''}`}
                            onClick={() => onActivateWorkspace(ws.id)}
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

                    {orderedWorkspaces.map((ws) => {
                        const wsAll = (byWorkspace.get(ws.id) ?? []).filter(matches);
                        const wsSpecs = wsAll.filter((s) => s.type !== 'process');
                        const wsProcs = wsAll.filter((s) => s.type === 'process');
                        const collapsed = collapsedWorkspaces.has(ws.id);
                        const isActive = ws.id === activeWorkspaceId;
                        const dragging = draggingId.current === ws.id;
                        const toggleCollapse = () =>
                            setCollapsedWorkspaces((prev) => {
                                const next = new Set(prev);
                                if (collapsed) next.delete(ws.id);
                                else next.add(ws.id);
                                return next;
                            });
                        return (
                            <div
                                key={ws.id}
                                className={`tproj${collapsed ? ' collapsed' : ''}${
                                    isActive ? ' is-active' : ''
                                }${dragging ? ' dragging' : ''}`}
                                onDragOver={(e) => {
                                    if (!draggingId.current) return;
                                    e.preventDefault();
                                    reorderPreview(ws.id);
                                }}
                                onDrop={(e) => {
                                    if (!draggingId.current) return;
                                    e.preventDefault();
                                    commitReorder();
                                }}
                            >
                                <button
                                    type="button"
                                    className="tproj-head"
                                    onClick={() => onActivateWorkspace(ws.id)}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        onOpenProjectMenu(ws.id, {
                                            x: e.clientX,
                                            y: e.clientY,
                                        });
                                    }}
                                >
                                    <span
                                        className="tproj-grip"
                                        role="button"
                                        tabIndex={-1}
                                        title="Drag to reorder"
                                        draggable
                                        onClick={(e) => e.stopPropagation()}
                                        onDragStart={(e) => {
                                            draggingId.current = ws.id;
                                            setDragOrder(workspaces.map((w) => w.id));
                                            e.dataTransfer.effectAllowed = 'move';
                                            // Firefox needs data set to start a drag.
                                            e.dataTransfer.setData('text/plain', ws.id);
                                        }}
                                        onDragEnd={() => commitReorder()}
                                    >
                                        <IconGrip size={12} />
                                    </span>
                                    <span
                                        className="chev"
                                        role="button"
                                        tabIndex={-1}
                                        title={collapsed ? 'Expand' : 'Collapse'}
                                        onClick={(e) => {
                                            // Chevron toggles collapse WITHOUT
                                            // activating the workspace.
                                            e.stopPropagation();
                                            toggleCollapse();
                                        }}
                                    >
                                        <IconChevronDown />
                                    </span>
                                    <span className="pico">{workspaceIcon(ws, 14)}</span>
                                    <span className="pname">{ws.project_name}</span>
                                    {ws.shape === 'agi' && (
                                        <span className="agi-badge" title="Aionima .agi envelope">
                                            .agi
                                        </span>
                                    )}
                                    {ws.shape === 'agi' && <AgiHealth ws={ws} />}
                                    <span
                                        className={`proc-ind proc-${wsProcStatus(
                                            wsProcs,
                                        )}${
                                            expandedProcs.has(ws.id) ? ' open' : ''
                                        }`}
                                        role="button"
                                        tabIndex={-1}
                                        title={
                                            wsProcs.length
                                                ? `Background processes (${wsProcs.length})`
                                                : 'Background processes'
                                        }
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleProcs(ws.id);
                                        }}
                                    >
                                        <IconCpu size={13} />
                                    </span>
                                    <span className="pcount">{wsSpecs.length}</span>
                                </button>
                                <div className="tproj-body">
                                    {wsSpecs.map((s) => (
                                        <SpecRow
                                            key={s.id}
                                            spec={s}
                                            checked={selected.has(s.id)}
                                            live={activeIds.has(s.id)}
                                            attention={attentionIds.has(s.id)}
                                            suspended={s.enabled === false}
                                            hostKind={hostBadgeKind(ws.backend)}
                                            hostLabel={ws.backend}
                                            onToggle={() => onToggleSpec(s.id)}
                                            onDestroy={() => onDestroySpec(s.id)}
                                            onDisable={() => onDisableSpec(s.id)}
                                            onEnable={() => onEnableSpec(s.id)}
                                            onContextMenu={(p) =>
                                                onOpenContextMenu(s.id, p)
                                            }
                                        />
                                    ))}
                                    <div className="tproj-adds">
                                        <button
                                            type="button"
                                            className="tterm tterm-add"
                                            onClick={() => onAddSpec(ws.id, 'terminal')}
                                        >
                                            <span className="pick" />
                                            <IconPlus size={12} />
                                            <span className="tname">Add Terminal…</span>
                                        </button>
                                        <button
                                            type="button"
                                            className="tterm tterm-add"
                                            onClick={() => onAddSpec(ws.id, 'code')}
                                        >
                                            <span className="pick" />
                                            <IconCode size={12} />
                                            <span className="tname">Add Editor…</span>
                                        </button>
                                    </div>
                                    {expandedProcs.has(ws.id) && (
                                        <div className="tproj-procs">
                                            <div className="tproj-subhead">
                                                <IconCpu size={12} />
                                                <span>Processes</span>
                                            </div>
                                            {wsProcs.length === 0 && (
                                                <div className="proc-empty">
                                                    No background processes yet.
                                                </div>
                                            )}
                                            {wsProcs.map((s) => {
                                                const st =
                                                    processStatus.get(s.id) ?? 'stopped';
                                                const live =
                                                    st === 'running' ||
                                                    st === 'restarting';
                                                return (
                                                    <div
                                                        key={s.id}
                                                        className="proc-row"
                                                        title={s.meta?.command}
                                                    >
                                                        <span
                                                            className={`proc-dot proc-${st}`}
                                                        />
                                                        <span className="proc-name">
                                                            {s.label}
                                                        </span>
                                                        {live ? (
                                                            <button
                                                                type="button"
                                                                className="proc-act"
                                                                title="Stop"
                                                                onClick={() =>
                                                                    void api().process.stop(
                                                                        s.id,
                                                                    )
                                                                }
                                                            >
                                                                <IconPause size={12} />
                                                            </button>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                className="proc-act proc-go"
                                                                title="Start"
                                                                onClick={() =>
                                                                    void api().process.start(
                                                                        s.id,
                                                                    )
                                                                }
                                                            >
                                                                <IconPlay size={12} />
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            className="proc-act"
                                                            title="Restart"
                                                            onClick={() =>
                                                                void api().process.restart(
                                                                    s.id,
                                                                )
                                                            }
                                                        >
                                                            <IconRefresh size={12} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="proc-act proc-del"
                                                            title="Delete process"
                                                            onClick={() =>
                                                                void deleteProcess(s)
                                                            }
                                                        >
                                                            <IconTrash size={12} />
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                            <button
                                                type="button"
                                                className="tterm tterm-add"
                                                onClick={() =>
                                                    void promptAddProcess(ws.id)
                                                }
                                            >
                                                <span className="pick" />
                                                <IconPlus size={12} />
                                                <span className="tname">
                                                    Add Process…
                                                </span>
                                            </button>
                                        </div>
                                    )}
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
                                        attention={attentionIds.has(s.id)}
                                        suspended={s.enabled === false}
                                        hostKind="desktop"
                                        hostLabel="local"
                                        onToggle={() => onToggleSpec(s.id)}
                                        onDestroy={() => onDestroySpec(s.id)}
                                        onDisable={() => onDisableSpec(s.id)}
                                        onEnable={() => onEnableSpec(s.id)}
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

/** Slug an envelope folder back to its base name (drops the .agi suffix). */
function envelopeSlug(ws: WorkspaceRow): string {
    const leaf = (ws.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    return leaf.replace(/\.agi$/i, '') || ws.project_name;
}

/**
 * Health dot for an .agi envelope: checks whether the structure docs
 * (README/AGENTS/CLAUDE) are present. When any are missing it shows an
 * amber alert that opens a popover explaining + a one-click "Add &
 * push" that backfills, commits, and pushes them. Stops the propagation
 * to the collapse toggle since it lives inside the header button.
 */
function AgiHealth({ ws }: { ws: WorkspaceRow }) {
    const [status, setStatus] = useState<StructureDocStatus | null>(null);
    const [mcp, setMcp] = useState<McpStatus | null>(null);
    const [open, setOpen] = useState(false);
    const [docsBusy, setDocsBusy] = useState(false);
    const [mcpBusy, setMcpBusy] = useState(false);
    const [done, setDone] = useState<string | null>(null);
    const [mcpDone, setMcpDone] = useState<string | null>(null);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const anchorRef = useRef<HTMLSpanElement>(null);
    const popRef = useRef<HTMLDivElement>(null);

    const refresh = () => {
        void api()
            .agi.docStatus(ws.path)
            .then(setStatus)
            .catch(() => setStatus(null));
        void api()
            .agi.mcpStatus(ws.path)
            .then(setMcp)
            .catch(() => setMcp(null));
    };
    useEffect(refresh, [ws.path]);

    // Position the portaled popover under the alert dot, clamped to the
    // viewport. Recomputed on open; closed on scroll/resize so it never
    // drifts away from its anchor.
    const place = () => {
        const r = anchorRef.current?.getBoundingClientRect();
        if (!r) return;
        const width = 268;
        const left = Math.min(
            Math.max(8, r.right - width),
            window.innerWidth - width - 8,
        );
        setCoords({ top: r.bottom + 6, left });
    };

    useEffect(() => {
        if (!open) return;
        place();
        const onAway = (e: MouseEvent) => {
            const t = e.target as Node;
            if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onScrollResize = () => setOpen(false);
        document.addEventListener('mousedown', onAway);
        window.addEventListener('resize', onScrollResize);
        // Capture scroll on any ancestor (the sidebar list scrolls).
        window.addEventListener('scroll', onScrollResize, true);
        return () => {
            document.removeEventListener('mousedown', onAway);
            window.removeEventListener('resize', onScrollResize);
            window.removeEventListener('scroll', onScrollResize, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const docsMissing = !!status && status.isEnvelope && status.missing;
    const mcpPending = !!mcp && mcp.needsConsolidation;
    // Show the alert only for a real envelope with at least one issue.
    if (!status || !status.isEnvelope || (!docsMissing && !mcpPending)) return null;

    const missingList = [
        !status.hasReadme && 'README.md',
        !status.hasAgents && 'AGENTS.md',
        !status.hasClaude && 'CLAUDE.md',
    ].filter(Boolean) as string[];

    const add = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setDocsBusy(true);
        setDone(null);
        try {
            const r = await api().agi.addDocs(ws.path, ws.project_name, envelopeSlug(ws));
            setDone(
                r.pushed
                    ? `Added + pushed ${r.added.length} file${r.added.length === 1 ? '' : 's'}.`
                    : r.committed
                        ? `Added + committed. Push skipped${r.pushError ? `: ${r.pushError}` : ' (no remote).'}`
                        : 'Nothing to add.',
            );
            refresh();
        } catch (err) {
            setDone(err instanceof Error ? err.message : String(err));
        } finally {
            setDocsBusy(false);
        }
    };

    const doConsolidateMcp = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setMcpBusy(true);
        setMcpDone(null);
        try {
            const r = await api().agi.consolidateMcp(ws.path);
            const n = r.servers.length;
            setMcpDone(
                r.gitignored
                    ? `Wrote config for ${n} server${n === 1 ? '' : 's'} to the envelope root. Local sessions use it now; not committed — these files are gitignored (they can hold MCP tokens).`
                    : !r.committed
                        ? 'MCP config already up to date.'
                        : r.pushed
                            ? `Consolidated ${n} server${n === 1 ? '' : 's'} + pushed.`
                            : `Consolidated ${n} server${n === 1 ? '' : 's'}. Push skipped${r.pushError ? `: ${r.pushError}` : ' (no remote).'}`,
            );
            refresh();
        } catch (err) {
            setMcpDone(err instanceof Error ? err.message : String(err));
        } finally {
            setMcpBusy(false);
        }
    };

    return (
        <span className="agi-health" ref={anchorRef}>
            <span
                className="agi-health-dot"
                role="button"
                tabIndex={0}
                title="Envelope is missing structure docs"
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => !o);
                }}
            >
                <IconAlert size={13} />
            </span>
            {open &&
                coords &&
                createPortal(
                    <div
                        ref={popRef}
                        className="agi-health-pop"
                        role="tooltip"
                        style={{ top: coords.top, left: coords.left }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="ahp-title">Envelope needs attention</div>

                        {docsMissing && (
                            <div className="ahp-section">
                                <div className="ahp-body">
                                    Missing structure docs:{' '}
                                    {missingList.map((m, i) => (
                                        <span key={m}>
                                            {i > 0 ? ', ' : ''}
                                            <code>{m}</code>
                                        </span>
                                    ))}
                                    . They explain the monorepo to humans (README)
                                    and agents (AGENTS/CLAUDE). Existing files are
                                    left untouched.
                                </div>
                                {done ? (
                                    <div className="ahp-done">{done}</div>
                                ) : (
                                    <button
                                        type="button"
                                        className="ahp-btn"
                                        onClick={add}
                                        disabled={docsBusy}
                                    >
                                        {docsBusy
                                            ? 'Working…'
                                            : status.hasRemote
                                                ? 'Add docs, commit & push'
                                                : 'Add docs & commit'}
                                    </button>
                                )}
                            </div>
                        )}

                        {mcpPending && (
                            <div className="ahp-section">
                                <div className="ahp-body">
                                    {mcp!.missingAtRoot.length > 0 ? (
                                        <>
                                            MCP server
                                            {mcp!.missingAtRoot.length === 1 ? '' : 's'}{' '}
                                            {mcp!.missingAtRoot.map((s, i) => (
                                                <span key={s}>
                                                    {i > 0 ? ', ' : ''}
                                                    <code>{s}</code>
                                                </span>
                                            ))}{' '}
                                            defined in repos aren't surfaced at the
                                            envelope root.
                                        </>
                                    ) : (
                                        <>
                                            The envelope's <code>.mcp.json</code> and{' '}
                                            <code>.cursor/mcp.json</code> are out of
                                            sync.
                                        </>
                                    )}{' '}
                                    Consolidate so sessions opened on the monorepo
                                    pick them up.
                                </div>
                                {mcpDone ? (
                                    <div className="ahp-done">{mcpDone}</div>
                                ) : (
                                    <button
                                        type="button"
                                        className="ahp-btn"
                                        onClick={doConsolidateMcp}
                                        disabled={mcpBusy}
                                    >
                                        {mcpBusy ? 'Working…' : 'Consolidate MCP config'}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>,
                    document.body,
                )}
        </span>
    );
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
    /** Agent-integration MCP: this terminal is pulsing for attention (imDone). */
    attention?: boolean;
    /** Tier 2: this spec is disabled-but-retained (suspended). */
    suspended: boolean;
    hostKind: string;
    hostLabel: string;
    onToggle: () => void;
    onDestroy: () => void;
    onDisable: () => void;
    onEnable: () => void;
    onContextMenu: (position: { x: number; y: number }) => void;
}

/**
 * One terminal row in the tree. The whole row is the toggle target; the
 * trash button on the right is a separate button that stops event
 * propagation so clicking it destroys the spec without also toggling
 * selection. A confirm guard fires for the destroy path because it
 * removes the spec from the DB and can't be undone.
 *
 * Tier 2: a SUSPENDED row (disabled-but-retained) reads greyed with a
 * "Suspended" badge; clicking it (or its Resume button) re-enables and
 * reattaches to the live pty. An ENABLED terminal row offers a Suspend
 * button next to Delete so disabling is reachable from the tree too.
 */
function SpecRow({
    spec,
    checked,
    live,
    attention,
    suspended,
    hostKind,
    hostLabel,
    onToggle,
    onDestroy,
    onDisable,
    onEnable,
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
    const isTerminal = spec.type !== 'code';
    // Suspended rows resume on click; live rows toggle grid selection.
    const onRowClick = suspended ? onEnable : onToggle;
    return (
        <div
            className={`tterm${checked ? ' on sel' : ''}${suspended ? ' suspended' : ''}${attention ? ' attention' : ''}`}
            role="button"
            tabIndex={0}
            onClick={onRowClick}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick();
                }
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu({ x: e.clientX, y: e.clientY });
            }}
            style={{ cursor: 'pointer' }}
        >
            <span className="pick">{checked && !suspended && <IconCheck size={11} />}</span>
            {spec.type === 'code' ? (
                <span className="srow-ico code" title="Editor">
                    <IconCode size={12} />
                </span>
            ) : (
                <span className={`sdot ${suspended ? 'idle' : live ? 'run' : 'idle'}`} />
            )}
            <span className="tname">{spec.label}</span>
            {suspended ? (
                <span className="susp-badge" title="Suspended — pty still running">
                    Suspended
                </span>
            ) : (
                <span className={`host ${hostKind}`}>{hostLabel}</span>
            )}
            {suspended ? (
                <button
                    type="button"
                    className="tterm-act"
                    onClick={(e) => {
                        e.stopPropagation();
                        onEnable();
                    }}
                    title="Resume — reattach to the live session"
                    aria-label={`Resume ${spec.label}`}
                >
                    <IconPlay size={12} />
                </button>
            ) : (
                isTerminal && (
                    <button
                        type="button"
                        className="tterm-act"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDisable();
                        }}
                        title="Suspend — keep running, hide panel"
                        aria-label={`Suspend ${spec.label}`}
                    >
                        <IconPause size={12} />
                    </button>
                )
            )}
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
