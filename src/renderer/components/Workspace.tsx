import { IssueWatchPanel } from './IssueWatchPanel.js';
import type { IssueWatchPanelView } from '../../core/issue-watch.js';
import { useCallback, useEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from 'react';
import { DesignedTab } from './DesignedTab.js';
import { WorkspaceTabs } from './WorkspaceTabs.js';
import { SitePanel } from './SitePanel.js';
import { addTab, clearCell, parseTabs, placePanel, removeTab, renameTab, serializeTabs, setLayout, type TabsState } from '../../core/workspace-tabs.js';
import {
    activate,
    emptyWorkspace,
    terminalClosed,
    terminalData,
    terminalExited,
    terminalOpened,
    type WorkspaceState,
} from '../../core/workspace-view.js';
import { codeClosed, codeOpened, pluginClosed, pluginOpened, terminalHidden, terminalShown, terminalSuspended } from '../../core/workspace-view.js';
import { Badge, Button, Icon } from '@particle-academy/react-fancy';
import { agentFilesLine, agentFilesWhen, type AgentFilesReport } from '../../core/agent-files-health.js';
import type { SyncResult } from '../../core/integrations.js';
import type { GenieBridge } from '../bridge.js';
import type { RepoEntry } from '../../core/repo-registry.js';
import { SETTINGS } from '../../core/settings.js';
import { LAYOUT_MODES, dragSplit, gridTemplate, layoutModeFrom, serializeSplits, splitsFrom, visiblePanes } from '../../core/panel-layout.js';
import type { TerminalPaneProps } from './TerminalPane.js';
import { FilesPanelContainer } from './FilesPanelContainer.js';
import { reattachAll } from '../reattach.js';
import { PluginPane, type PluginPanelView } from './PluginPane.js';
import type { AgentRow } from '../../core/dashboard-view.js';
import type { WorkspaceView } from '../../core/route.js';
import { workspaceHome, type HomeFilesState } from '../../core/workspace-home.js';
import { FidelityDot } from './Dashboard.js';
import { repoChip } from '../../core/repo-status.js';
import { WorkspaceHome } from './WorkspaceHome.js';

/**
 * THE WORKSPACE SURFACE — §4.6. Terminals, for shells, builds, services and hosted sites.
 *
 * **No agent has one.** The only ids on this surface are workspace ids and terminal ids; the
 * bridge it talks to cannot express an agent, and that absence is the renderer's half of the
 * one rule.
 *
 * ## Shape
 *
 * A 32px tab strip — one tab per terminal, `+ terminal` at the end — over a single pane that
 * shows the ACTIVE terminal. `fancy-term`'s `<Terminal>` renders it: the controlled `output`
 * prop takes the whole buffer and writes only the appended delta; keystrokes come back through
 * `onData` and go to the pty; `onResize` keeps the pty's grid in step with the pane.
 *
 * Inactive terminals are not rendered at all. Their output accumulates in state and is written
 * in one piece when they become active, which is what `output` is for — rendering six xterms
 * to show one is six times the work for nothing on screen.
 *
 * State lives in `workspace-view.ts` and is pure; this file owns the wiring and nothing else.
 */

/** Workspace operations (§6.1) as the surface sees them; absent = none offered (a remote guest, a test). */
export interface WorkspaceOpsProps {
    readonly asleep: boolean;
    readonly agentCount: number;
    /** The remove is CONFIRMED on a card first. */
    readonly removePreview: boolean;
    readonly lastOutcome: string | null;
    readonly onHibernate: () => void;
    readonly onWake: () => void;
    readonly onPreviewRemove: () => void;
    readonly onConfirmRemove: () => void;
    readonly onCancelRemove: () => void;
    /** The repo registry (§6.1); absent = not offered here. `list: null` = not loaded yet. */
    readonly repos?: {
        readonly list: readonly RepoEntry[] | null;
        /** "Remove stale lock" on a red repo chip (the board's fix). */
        readonly onRemoveLock?: ((slug: string) => void) | undefined;
        readonly onAdd: (input: { name: string; path: string }) => void;
        readonly onRemove: (slug: string) => void;
        readonly onOpen: (path: string) => void;
    } | undefined;
    /** Ops projects (§6.1): which other workspaces this one governs; absent = not offered. */
    readonly governs?: {
        readonly children: readonly string[];
        /** `name` is what the checkbox says; the id is what is sent back. */
        readonly candidates: readonly { id: string; name?: string | undefined }[];
        readonly onSet: (childIds: string[]) => void;
    } | undefined;
    /** The workspace-scoped settings (§6.1) with THIS workspace's effective values; `values: null` = not loaded yet. */
    readonly settings?: {
        readonly values: Readonly<Record<string, boolean | string>> | null;
        /** Keys this workspace overrides (the workstation value differs). */
        readonly overridden: readonly string[];
        readonly onSet: (key: string, value: boolean | string) => void;
        readonly onReset: (key: string) => void;
    } | undefined;
    /**
     * THIS workspace's agent files (§6.9): what Genie's last sync did here — when, and whether it was Genie's start or
     * you — and a Sync now for this workspace alone. `report: null` = not synced since Genie started; `results` = the
     * four harness configs of your last Sync now here. Absent = not offered.
     */
    readonly agentFiles?: {
        readonly report: AgentFilesReport | null;
        readonly results: readonly SyncResult[] | null;
        readonly onSync: () => void;
    } | undefined;
}

export interface WorkspaceProps {
    /** The registry's workspace row. `name` is optional there, so the id stands in — never an invented label. */
    workspace: { id: string; name?: string; path: string };
    terminals: GenieBridge['terminals'];
    ops?: WorkspaceOpsProps | undefined;
    /** The file panel (§4.3), mounted for `?panel=files`; absent = no files host in this window. */
    files?: GenieBridge['files'] | undefined;
    /** The panels ENABLED plugins contribute (§4.6 `+plugin`); absent or empty = no `+plugin`. */
    pluginPanels?: readonly PluginPanelView[] | undefined;
    /** IssueWatch's view of this workspace (Tynn #806); absent = none to show, and no GitHub tab. */
    issueWatch?: IssueWatchPanelView | null | undefined;
    panel?: 'files' | null | undefined;
    onTogglePanel?: (() => void) | undefined;
    /** The file panel's route keys (`?files=<path>&filter=changed`) and their write-back. */
    filesFile?: string | null | undefined;
    /** The line that file opens at (the route's `line=`). */
    filesLine?: number | null | undefined;
    filesFilter?: 'changed' | null | undefined;
    onFilesRoute?: ((file: string | null, filter: 'changed' | null) => void) | undefined;
    /** The file panel is in the dock (§4.4): do not draw it inline too. */
    filesPinned?: boolean | undefined;
    onPinFiles?: (() => void) | undefined;
    /** The panel is in its own window (§4.3): not inline either — a bar brings it back. */
    filesPopped?: boolean | undefined;
    onPopOutFiles?: (() => void) | undefined;
    onBringBackFiles?: (() => void) | undefined;
    onPauseAgent?: ((agent: string, path: string) => void) | undefined;
    onResumeAgent?: ((agent: string, path: string) => void) | undefined;
    /** The strip's starting state — for tests that render tabs server-side. Defaults to empty. */
    initialState?: WorkspaceState | undefined;
    /**
     * Which view of the workspace (`core/route.ts`): `home` — the board's workspace surface, its AGENTS and what
     * changed — is the default; `terminals` is §4.6; `settings` holds governs, the workspace settings and the repos.
     * The owner, 2026-10-12: "when I select a workspace, I should not see the workspace settings, I should see the
     * agent lanes and all of the agents."
     */
    view?: WorkspaceView | undefined;
    /** Every agent Genie knows of; the home view keeps this workspace's. Absent = none known. */
    rows?: readonly AgentRow[] | undefined;
    onOpenAgent?: ((agentId: string) => void) | undefined;
    /** The agents open as tabs in this workspace's strip (Tynn #805), and closing one. */
    openAgents?: ReadonlyArray<{ id: string; name: string; state: string }> | undefined;
    onCloseAgent?: ((agentId: string) => void) | undefined;
    onAddAgent?: (() => void) | undefined;
    /** The tabs ask for a view; the shell writes it into the route. */
    onViewChange?: ((view: WorkspaceView) => void) | undefined;
}


/** `1.2 kB`, `340 B` — how much output a suspended terminal held back. */
function formatHeld(bytes: number): string {
    return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`;
}

export function Workspace({ workspace, terminals, ops, initialState, files, panel, onTogglePanel, filesFile, filesLine = null, filesFilter, onFilesRoute, filesPinned, onPinFiles, filesPopped, onPopOutFiles, onBringBackFiles, onPauseAgent, onResumeAgent, pluginPanels = [], issueWatch = null, view = 'home', rows = [], onOpenAgent, onAddAgent, onViewChange, openAgents = [], onCloseAgent }: WorkspaceProps) {
    const [state, setState] = useState<WorkspaceState>(() => initialState ?? emptyWorkspace());
    // THE TABS YOU DESIGNED (Tynn #282), kept in this workspace's `workspace_tabs` setting; read forgivingly.
    const tabsRaw = ops?.settings?.values?.['workspace_tabs'];
    const designed = parseTabs(typeof tabsRaw === 'string' ? tabsRaw : '{"tabs":[]}');
    const canDesign = Boolean(ops?.settings && ops.settings.values !== null);
    const saveTabs = (next: TabsState): void => { ops?.settings?.onSet('workspace_tabs', serializeTabs(next)); };
    const [designNotice, setDesignNotice] = useState<string | null>(null);
    // The file host's state for "Changes this session" (home view): read on mount and on every change the host
    // reports; `null` until it answers, which the rail renders as an ABSENT section, not an empty one.
    const [filesState, setFilesState] = useState<HomeFilesState | null>(null);
    useEffect(() => {
        if (view !== 'home' || !files) return;
        let live = true;
        const read = () => { void files.state(workspace.id).then((s) => { if (live) setFilesState(s); }); };
        read();
        const off = files.onChange((id) => { if (id === workspace.id) read(); });
        return () => { live = false; off(); };
    }, [view, files, workspace.id]);
    const home = workspaceHome(rows, workspace.id, filesState);
    const filesInline = panel === 'files' && files !== undefined && !filesPinned && !filesPopped;
    const label = workspace.name ?? workspace.id;
    /*
     * The xterm pane, loaded CLIENT-SIDE ONLY. `@xterm/xterm` touches `self` at module
     * evaluation, so a static import of `fancy-term` anywhere Node can reach — the SSR render
     * tests — throws before any component runs. `TerminalPane.tsx` is the one module that
     * imports it, and it is reached only from this effect, which never runs under
     * `react-dom/server`. Until it resolves the pane renders nothing; the empty state and the
     * tab strip do not wait for it.
     */
    const [Pane, setPane] = useState<ComponentType<TerminalPaneProps> | null>(null);
    useEffect(() => {
        let live = true;
        void import('./TerminalPane.js').then((m) => { if (live) setPane(() => m.TerminalPane); });
        return () => { live = false; };
    }, []);
    /** A pane size the engine can be opened at, so the first paint is not the wrong shape. */
    const lastSize = useRef<{ cols: number; rows: number }>({ cols: 120, rows: 30 });
    /** The previous session is seeded into the FIRST terminal opened here, once (§6.5). */
    const seededPrevious = useRef(false);

    // Output and exits for EVERY terminal arrive on the same channel; the reducer drops what is
    // not this workspace's. Subscribed once per mount, released on unmount — the old build
    // leaked one listener per reopened panel.
    useEffect(() => {
        const offData = terminals.onData((id, data) => setState((s) => terminalData(s, id, data)));
        const offExit = terminals.onExit((id, code) => setState((s) => terminalExited(s, id, code)));
        return () => {
            offData();
            offExit();
        };
    }, [terminals]);

    // Re-attach to terminals already open in this workspace — a reloaded window joins a running
    // build rather than losing it (§6.5). Their scrollback comes with the open.
    useEffect(() => {
        let live = true;
        // JOIN, never open: the old loop spawned one new shell per listed terminal on every reload (§6.5).
        void reattachAll(terminals, workspace.id).then((joined) => {
            if (!live) return;
            for (const t of joined) {
                setState((s) => terminalOpened(s, { id: t.id, pid: t.pid, shell: t.shell, workspaceId: workspace.id, exited: null }, t.scrollback));
            }
        });
        return () => { live = false; };
    }, [terminals, workspace.id]);

    const openTerminal = useCallback(() => {
        const previous = seededPrevious.current ? Promise.resolve<string | null>(null) : terminals.previousSession(workspace.id);
        seededPrevious.current = true;
        void Promise.all([terminals.open(workspace.id, { ...lastSize.current }), previous]).then(([opened, restored]) => {
            setState((s) =>
                terminalOpened(
                    s,
                    { id: opened.id, workspaceId: workspace.id, shell: opened.shell, pid: opened.pid, exited: null },
                    // A snapshot from the last quit opens ABOVE the divider; the new shell's own output follows live.
                    restored ?? opened.scrollback,
                    restored ? { restored: true } : {},
                ),
            );
        });
    }, [terminals, workspace.id]);

    const closeTerminal = useCallback(
        (id: string) => {
            terminals.close(id);
            setState((s) => terminalClosed(s, id));
        },
        [terminals],
    );

    const active = state.terminals.find((t) => t.id === state.active) ?? null;
    // LAYOUT (§6.5): the workspace's own setting decides how many panes show; the grid is for that count only.
    const layout = layoutModeFrom(ops?.settings?.values ?? {});
    const shown = visiblePanes(state, layout);
    // SPLITS (§4.6): remembered per workspace and per arrangement; a stored split that does not fit is equal panes.
    const splits = splitsFrom(ops?.settings?.values ?? {}, layout, shown.length);
    const template = gridTemplate(layout, shown.length, splits);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const startDrag = (index: number, axis: 'columns' | 'rows') => (e: ReactPointerEvent<HTMLDivElement>) => {
        const el = gridRef.current;
        const set = ops?.settings?.onSet;
        if (!el || !set) return;
        const total = axis === 'columns' ? el.clientWidth : el.clientHeight;
        const start = axis === 'columns' ? e.clientX : e.clientY;
        // Handles exist only in the columns and rows arrangements, where every shown pane is one track.
        const from = (axis === 'columns' ? splits.columns : splits.rows) ?? Array.from({ length: shown.length }, () => 1 / shown.length);
        const onMove = (ev: PointerEvent) => {
            const delta = ((axis === 'columns' ? ev.clientX : ev.clientY) - start) / Math.max(1, total);
            const next = dragSplit(from, index, delta);
            set('panel_splits', serializeSplits(String(ops?.settings?.values?.panel_splits ?? ''), layout, axis === 'columns' ? { columns: next, rows: splits.rows } : { columns: splits.columns, rows: next }));
        };
        const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };
    // Handles sit between tracks in the columns and rows arrangements; the 2×2 grid keeps equal tracks until it earns its own handles.
    const handleAxis: 'columns' | 'rows' | null = layout === 'columns' ? 'columns' : layout === 'rows' ? 'rows' : null;
    const handleFractions = handleAxis ? ((handleAxis === 'columns' ? splits.columns : splits.rows) ?? Array.from({ length: shown.length }, () => 1 / shown.length)) : [];

    // THE TERMINALS (§4.6): the workspace's terminal manager — the Terminals view, and a designed tab's terminal panel (Tynn #282).
    const terminalsBody = (<>
            {/* Tab strip, 32px. One tab per terminal; the add button last. */}
            <div data-terminal-tabs="" className="flex h-8 shrink-0 items-stretch border-b border-[var(--border-1)] bg-[var(--bg-1)]">
                {ops?.settings ? (
                    <div data-layout-control className="flex items-center gap-0.5 border-r border-[var(--border-1)] px-1.5" title="Terminal layout — remembered for this workspace">
                        {LAYOUT_MODES.map((m) => (
                            <button key={m} type="button" data-action={`layout-${m}`} {...(m === layout ? { 'data-current': 'true' } : {})} aria-label={`${m} layout`} onClick={() => ops.settings!.onSet('panel_layout', m)} className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${m === layout ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-4)] hover:bg-[var(--bg-2)]'}`}>
                                {m}
                            </button>
                        ))}
                    </div>
                ) : null}
                {state.terminals.map((t) => {
                    const isActive = t.id === state.active;
                    return (
                        <div
                            key={t.id}
                            data-terminal-tab={t.id}
                            data-active={isActive ? 'true' : 'false'}
                            {...(t.exited === null ? {} : { 'data-exited': String(t.exited) })}
                            className={`flex items-center gap-2 border-r border-[var(--border-1)] px-3 text-[12px] ${
                                isActive ? 'bg-[var(--bg-0)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)]'
                            }`}
                        >
                            <button type="button" onClick={() => setState((s) => activate(s, t.id))} className="flex items-center gap-2">
                                <Icon name="square-terminal" className="h-3.5 w-3.5" />
                                <span className="font-mono">{t.shell.split(/[\\/]/).pop()}</span>
                                {/*
                                 * An ended shell says so, with its code. `0` is an exit too: the
                                 * attribute is present for any number and absent only while
                                 * running — never a truthiness check (§5).
                                 */}
                                {t.exited === null ? null : (
                                    <span className="font-mono text-[11px] text-[var(--fg-4)]">exit {t.exited}</span>
                                )}
                            </button>
                            {/* HIDE keeps the shell running (§6.5); CLOSE ends it. Two controls, two words. */}
                            <button
                                type="button"
                                aria-label={t.suspended ? 'Resume output' : 'Suspend output'}
                                title={t.suspended ? `Resume — ${formatHeld(t.droppedWhileSuspended ?? 0)} held while suspended` : 'Suspend — keep the shell running, hold its output back'}
                                {...(t.suspended ? { 'data-terminal-suspended': t.id } : {})}
                                data-terminal-suspend={t.id}
                                onClick={() => setState((s) => terminalSuspended(s, t.id, !t.suspended))}
                                className="rounded px-1 text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]"
                            >
                                <Icon name={t.suspended ? 'play' : 'pause'} className="h-3 w-3" />
                                {t.suspended ? <span className="ml-1 font-mono text-[10px]">{formatHeld(t.droppedWhileSuspended ?? 0)} held</span> : null}
                            </button>
                            <button
                                type="button"
                                aria-label="Hide terminal (keeps running)"
                                title="Hide — the shell keeps running; show it again from the hidden chip"
                                data-terminal-hide={t.id}
                                onClick={() => setState((s) => terminalHidden(s, t.id))}
                                className="rounded px-1 text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]"
                            >
                                <Icon name="eye-off" className="h-3 w-3" />
                            </button>
                            <button
                                type="button"
                                aria-label="Close terminal"
                                data-terminal-close={t.id}
                                onClick={() => closeTerminal(t.id)}
                                className="rounded px-1 text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]"
                            >
                                <Icon name="x" className="h-3 w-3" />
                            </button>
                        </div>
                    );
                })}
                {(state.hidden ?? []).length > 0 ? (
                    <div data-terminal-hidden-list className="flex items-center gap-1 border-r border-[var(--border-1)] px-2 text-[12px] text-[var(--fg-3)]">
                        <Icon name="eye-off" className="h-3 w-3" />
                        <span>{(state.hidden ?? []).length} hidden</span>
                        {(state.hidden ?? []).map((h) => (
                            <button key={h.id} type="button" data-terminal-show={h.id} title={`Show ${h.shell.split(/[\\/]/).pop()} (pid ${h.pid})`} onClick={() => setState((s) => terminalShown(s, h.id))} className="rounded px-1 font-mono text-[11px] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]">
                                {h.shell.split(/[\\/]/).pop()}
                            </button>
                        ))}
                    </div>
                ) : null}
                {/* CODE PANES (§4.6): one file each, after the shells in the strip. */}
                {(state.codes ?? []).map((c) => {
                    const isActive = c.id === state.active;
                    return (
                        <div key={c.id} data-code-tab={c.id} data-active={isActive ? 'true' : 'false'} className={`flex items-center gap-2 border-r border-[var(--border-1)] px-3 text-[12px] ${isActive ? 'bg-[var(--bg-0)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)]'}`}>
                            <button type="button" onClick={() => setState((s) => activate(s, c.id))} className="flex items-center gap-2">
                                <Icon name="file-code" className="h-3.5 w-3.5" />
                                <span className="font-mono">{c.path.split('/').pop()}</span>
                            </button>
                            <button type="button" aria-label={`close ${c.path}`} data-code-close={c.id} onClick={() => setState((s) => codeClosed(s, c.id))} className="rounded px-1 text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]">×</button>
                        </div>
                    );
                })}
                {/* PLUGIN PANES (§4.6): a plugin's panel, after the code panes in the strip. */}
                {(state.plugins ?? []).map((p) => {
                    const isActive = p.id === state.active;
                    const panel = pluginPanels.find((x) => x.pluginId === p.pluginId && x.id === p.panelId);
                    return (
                        <div key={p.id} data-plugin-tab={p.id} data-active={isActive ? 'true' : 'false'} className={`flex items-center gap-2 border-r border-[var(--border-1)] px-3 text-[12px] ${isActive ? 'bg-[var(--bg-0)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)]'}`}>
                            <button type="button" onClick={() => setState((s) => activate(s, p.id))} className="flex items-center gap-2">
                                <Icon name="layout-grid" className="h-3.5 w-3.5" />
                                <span>{panel?.title ?? p.panelId}</span>
                            </button>
                            <button type="button" aria-label={`close ${panel?.title ?? p.panelId}`} data-plugin-close={p.id} onClick={() => setState((s) => pluginClosed(s, p.id))} className="rounded px-1 text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]">×</button>
                        </div>
                    );
                })}
                <button
                    type="button"
                    data-terminal-add=""
                    onClick={openTerminal}
                    className="flex items-center gap-1.5 px-3 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"
                >
                    <Icon name="plus" className="h-3.5 w-3.5" />
                    terminal
                </button>
                {files ? (
                    <button type="button" data-action="add-code" title="Open a file as its own pane: pick it in the file panel, then ⧉ on its tab" onClick={() => { if (panel !== 'files') onTogglePanel?.(); }} className="flex items-center gap-1.5 px-3 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]">
                        <Icon name="plus" className="h-3.5 w-3.5" />
                        code
                    </button>
                ) : null}
                {pluginPanels.length > 0 ? (
                    <details data-action="add-plugin-pane" className="relative">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"><Icon name="plus" className="h-3.5 w-3.5" />plugin</summary>
                        <ul className="absolute right-0 top-full z-20 min-w-48 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-1 shadow-lg">
                            {pluginPanels.map((p) => (
                                <li key={`${p.pluginId}/${p.id}`}>
                                    <button type="button" data-plugin-panel={`${p.pluginId}/${p.id}`} onClick={() => setState((s) => pluginOpened(s, p.pluginId, p.id))} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-[var(--bg-2)]">
                                        <span>{p.title}</span>
                                        <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{p.pluginName}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </details>
                ) : null}
            </div>

            {/* The pane. One xterm, for the active terminal; an invitation when there is none. */}
            <div className="min-h-0 flex-1 bg-[var(--bg-0)]">
                {shown.length > 0 ? (
                    <div ref={gridRef} data-layout={layout} className="relative grid h-full min-h-0 gap-px bg-[var(--border-1)]" style={{ gridTemplateColumns: template.columns, gridTemplateRows: template.rows }}>
                        {/* SPLIT HANDLES (§4.6): one between each pair of tracks; dragging writes panel_splits for this arrangement. */}
                        {handleAxis && shown.length > 1 ? handleFractions.slice(0, -1).map((_, i) => {
                            const at = handleFractions.slice(0, i + 1).reduce((a, b) => a + b, 0) * 100;
                            return handleAxis === 'columns'
                                ? <div key={i} data-split-handle={i} role="separator" aria-orientation="vertical" onPointerDown={startDrag(i, 'columns')} className="absolute inset-y-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-[var(--accent)]/40" style={{ left: `${at}%` }} />
                                : <div key={i} data-split-handle={i} role="separator" aria-orientation="horizontal" onPointerDown={startDrag(i, 'rows')} className="absolute inset-x-0 z-10 h-1.5 -translate-y-1/2 cursor-row-resize hover:bg-[var(--accent)]/40" style={{ top: `${at}%` }} />;
                        }) : null}
                        {shown.map((id) => {
                            const plugin = (state.plugins ?? []).find((p) => p.id === id);
                            if (plugin) {
                                const panel = pluginPanels.find((x) => x.pluginId === plugin.pluginId && x.id === plugin.panelId);
                                return (
                                    <div key={id} data-pane-slot={id} data-pane-kind="plugin" {...(id === state.active ? { 'data-pane-active': '' } : {})} className="min-h-0 min-w-0 bg-[var(--bg-0)]" onFocusCapture={() => { if (id !== state.active) setState((s) => activate(s, id)); }}>
                                        {panel ? <PluginPane panel={panel} /> : (
                                            <p data-plugin-pane-missing={`${plugin.pluginId}/${plugin.panelId}`} className="p-3 text-[13px] text-[var(--fg-3)]">The plugin {plugin.pluginId} is not enabled any more (or no longer offers this panel); close this pane.</p>
                                        )}
                                    </div>
                                );
                            }
                            const code = (state.codes ?? []).find((c) => c.id === id);
                            if (code) {
                                return (
                                    <div key={id} data-pane-slot={id} data-pane-kind="code" {...(id === state.active ? { 'data-pane-active': '' } : {})} className="min-h-0 min-w-0 bg-[var(--bg-0)]" onFocusCapture={() => { if (id !== state.active) setState((s) => activate(s, id)); }}>
                                        {files ? <FilesPanelContainer workspace={workspace} files={files} pinned={false} single={code.path} onPin={() => {}} onClose={() => setState((s) => codeClosed(s, id))} onPause={onPauseAgent} onResume={onResumeAgent} /> : null}
                                    </div>
                                );
                            }
                            const t = state.terminals.find((x) => x.id === id)!;
                            return (
                                <div key={id} data-pane-slot={id} {...(id === state.active ? { 'data-pane-active': '' } : {})} className="min-h-0 min-w-0 bg-[var(--bg-0)]" onFocusCapture={() => { if (id !== state.active) setState((s) => activate(s, id)); }}>
                                    {Pane ? (
                                        <Pane
                                            key={id}
                                            paneId={id}
                                            output={state.output[id] ?? ''}
                                            readOnly={t.exited !== null}
                                            onData={(data) => terminals.write(id, data)}
                                            onResize={({ cols, rows }) => {
                                                lastSize.current = { cols, rows };
                                                terminals.resize(id, cols, rows);
                                            }}
                                        />
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div data-terminal-empty="" className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--fg-3)]">
                        <p>No terminals open in {workspace.name ?? workspace.id}.</p>
                        <button
                            type="button"
                            data-terminal-add-empty=""
                            onClick={openTerminal}
                            className="rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]"
                        >
                            Open a terminal
                        </button>
                    </div>
                )}
            </div>
    </>);

    return (
        <section data-surface="workspace" data-workspace={workspace.id} className="flex h-full min-h-0 flex-col">
            {/* View header, 56px — the workspace's name and path, like the Dashboard's group header. */}
            <header data-view-header="" className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-5">
                <h1 className="text-[18px] font-semibold text-[var(--fg-1)]">{workspace.name ?? workspace.id}</h1>
                <span className="font-mono text-[11px] text-[var(--fg-4)]">{workspace.path}</span>
                {/* REPO CHIPS (the board): `api · main` per repo; a locked repo in red, with "Remove stale lock" once the lock is stale. */}
                {ops?.repos?.list ? ops.repos.list.map((r) => {
                    const chip = repoChip({ slug: r.slug, branch: r.branch ?? null, lock: r.lock ?? null });
                    return (
                        <span key={r.slug} className="flex shrink-0 items-center gap-1.5">
                            <span data-repo-chip={r.slug} data-tone={chip.tone} className={`flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] ${chip.tone === 'bad' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--border-1)] text-[var(--fg-2)]'}`}>
                                <Icon name={chip.tone === 'bad' ? 'circle-alert' : 'git-branch'} className="h-3 w-3" />
                                {chip.label}
                            </span>
                            {chip.fix ? <button type="button" data-action="remove-stale-lock" data-repo-slug={r.slug} onClick={() => ops.repos?.onRemoveLock?.(r.slug)} className="rounded-md border border-[var(--border-2)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]">{chip.fix}</button> : null}
                        </span>
                    );
                }) : null}
                {/* The agents strip (the board's header): a pill per agent — state dot, name — each opening the agent. */}
                {home.agents.length > 0 ? (
                    <div data-agents-strip="" className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto">
                        {home.agents.map((a) => (
                            <button key={a.id} type="button" data-agent-pill={a.id} title={`${a.name} · ${a.word.toLowerCase()}`} onClick={() => onOpenAgent?.(a.id)} className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-1)] px-2 py-0.5 text-[11px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                                <FidelityDot fidelity={a.fidelity} state={a.state} />
                                <span>{a.name}</span>
                            </button>
                        ))}
                    </div>
                ) : null}
                {files ? (
                    <button type="button" data-action="toggle-files" data-panel-open={panel === 'files' ? 'true' : 'false'} onClick={onTogglePanel} title="The workspace's files: one panel, who is touching what (⌘B)" className={`ml-auto flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)] ${panel === 'files' ? 'bg-[var(--bg-3)]' : ''}`}><Icon name="folder-tree" size="xs" />Files<kbd className="font-mono text-[10px] text-[var(--fg-4)]">⌘B</kbd></button>
                ) : null}
                {ops ? (
                    <div className={`${files ? '' : 'ml-auto '}flex items-center gap-1`}>
                        {ops.asleep ? (
                            <button type="button" data-action="wake" onClick={ops.onWake} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">Wake</button>
                        ) : (
                            <button type="button" data-action="hibernate" title="Ask every agent for a handoff, then stop everything here; nothing starts until woken" onClick={ops.onHibernate} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">Hibernate</button>
                        )}
                        <button type="button" data-action="remove-workspace" onClick={ops.onPreviewRemove} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">Remove from Genie…</button>
                    </div>
                ) : null}
            </header>
            {/*
              * THE STRIP (Tynn #282): Agents, the tabs you designed, a small +, Settings — + always just before Settings,
              * Settings always last. Labelled tabs, never a shortcut-only door (§4.0). The + needs somewhere to keep a tab:
              * without the workspace's settings there is none, and a + that could not keep anything is not offered.
              */}
            <WorkspaceTabs
                designed={designed}
                openAgents={openAgents}
                current={{ kind: 'view', view }}
                canDesign={canDesign}
                hasSettings={Boolean(ops?.settings || ops?.governs || ops?.repos)}
                github={issueWatch?.linked === true}
                onView={(v) => onViewChange?.(v as WorkspaceView)}
                onAdd={() => { const made = addTab(designed); saveTabs(made.state); onViewChange?.(`tab:${made.id}`); }}
                onOpenAgent={(id) => onOpenAgent?.(id)}
                onCloseAgent={(id) => onCloseAgent?.(id)}
            />
            {ops?.asleep ? (
                <p data-asleep className="shrink-0 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-5 py-2 text-xs text-[var(--fg-2)]">
                    {workspace.name ?? workspace.id} is hibernating: nothing starts here until you wake it. It stays asleep through restarts and upgrades.
                </p>
            ) : null}
            {ops?.lastOutcome ? <p data-ops-outcome className="shrink-0 border-b border-[var(--border-1)] px-5 py-2 text-xs text-[var(--fg-2)]">{ops.lastOutcome}</p> : null}
            {ops?.removePreview ? (
                <div data-remove-confirm className="shrink-0 border-b border-[var(--warning)] bg-[var(--bg-1)] px-5 py-3 text-xs">
                    <p className="font-semibold">Remove {workspace.name ?? workspace.id} from Genie?</p>
                    <p className="mt-1 text-[var(--fg-2)]">
                        Genie forgets this workspace and its {ops.agentCount} agents. The folder <span className="font-mono">{workspace.path}</span> is not touched — every file stays where it is.
                    </p>
                    <div className="mt-2 flex gap-2">
                        <button type="button" data-action="confirm-remove" onClick={ops.onConfirmRemove} className="rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs text-white">Remove from Genie</button>
                        <button type="button" onClick={ops.onCancelRemove} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-xs">Cancel</button>
                    </div>
                </div>
            ) : null}

            {view === 'settings' && ops?.governs ? (
                <section data-governs className="shrink-0 border-b border-[var(--border-1)] px-5 py-2 text-xs">
                    <div className="flex items-center gap-3">
                        <h2 className="font-semibold">Governs</h2>
                        <span className="text-[var(--fg-4)]">An ops project governs other workspaces: they sit under it in the rail and the Dashboard, and its agents reach theirs as if from inside. Nothing is written into their folders.</span>
                    </div>
                    {ops.governs.candidates.length === 0 ? (
                        <p className="mt-1 text-[var(--fg-3)]">No other workspaces to govern.</p>
                    ) : (
                        <ul className="mt-1 flex flex-wrap gap-3">
                            {ops.governs.candidates.map((c) => {
                                const on = ops.governs!.children.includes(c.id);
                                return (
                                    <li key={c.id}>
                                        <label className="flex items-center gap-1.5">
                                            <input type="checkbox" data-govern-child={c.id} checked={on} onChange={(e) => ops.governs!.onSet(e.target.checked ? [...ops.governs!.children, c.id] : ops.governs!.children.filter((id) => id !== c.id))} />
                                            <span>{c.name ?? c.id}</span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            ) : null}
            {view === 'settings' && ops?.settings ? (
                <section data-workspace-settings className="shrink-0 border-b border-[var(--border-1)] px-5 py-2 text-xs">
                    <div className="flex items-center gap-3">
                        <h2 className="font-semibold">Workspace settings</h2>
                        <span className="text-[var(--fg-4)]">these apply to {workspace.name ?? workspace.id} only; an override replaces the workstation value</span>
                    </div>
                    {ops.settings.values === null ? (
                        <div data-ws-settings-skeleton className="mt-2 flex flex-col gap-1">
                            <div className="h-3 w-1/3 animate-pulse rounded bg-[var(--bg-2)]" />
                            <div className="h-3 w-1/4 animate-pulse rounded bg-[var(--bg-2)]" />
                        </div>
                    ) : (
                        <ul className="mt-1 divide-y divide-[var(--border-1)]">
                            {SETTINGS.filter((def) => def.scope === 'workspace' && !def.hidden).map((def) => {
                                const values = ops.settings!.values!;
                                const value = values[def.key] ?? def.default;
                                const overridden = ops.settings!.overridden.includes(def.key);
                                return (
                                    <li key={def.key} data-ws-setting={def.key} {...(overridden ? { 'data-ws-overridden': def.key } : {})} className="flex items-center gap-3 py-1.5">
                                        <div className="flex-1">
                                            <div className="font-medium">{def.label}</div>
                                            <div className="text-[var(--fg-3)]">{def.description}</div>
                                        </div>
                                        {def.type === 'boolean' ? (
                                            <input type="checkbox" checked={value === true} onChange={(e) => ops.settings!.onSet(def.key, e.target.checked)} />
                                        ) : def.type === 'enum' ? (
                                            <select value={String(value)} onChange={(e) => ops.settings!.onSet(def.key, e.target.value)} className="rounded-md border border-[var(--border-1)] bg-transparent px-1 py-0.5">
                                                {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        ) : (
                                            <input type="text" defaultValue={String(value)} onBlur={(e) => ops.settings!.onSet(def.key, e.target.value)} className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-0.5" />
                                        )}
                                        {overridden ? <button type="button" data-action="ws-setting-reset" data-ws-key={def.key} onClick={() => ops.settings!.onReset(def.key)} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]" title="Drop this workspace's override; the workstation value applies again">reset</button> : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            ) : null}
            {view === 'settings' && ops?.agentFiles ? (
                <section data-ws-agent-files="" className="shrink-0 border-b border-[var(--border-1)] px-5 py-2 text-xs">
                    <div className="flex items-center gap-3">
                        <h2 className="font-semibold">Agent files</h2>
                        <span className="text-[var(--fg-4)]">Genie’s instructions for agents here, and its MCP endpoint in this workspace’s Claude Code, Cursor and Codex configs; Genie syncs them when it starts</span>
                        <span className="ml-auto" />
                        <Button data-action="ws-sync-agent-files" size="sm" onClick={ops.agentFiles.onSync}>Sync now</Button>
                    </div>
                    {ops.agentFiles.report === null ? (
                        <p data-ws-agent-files-state="none" className="mt-1 text-[var(--fg-3)]">Not synced since Genie started.</p>
                    ) : (() => {
                        const r = ops.agentFiles.report;
                        const state = r.failed.length > 0 ? 'failed' : r.changed.length > 0 ? 'upgraded' : 'current';
                        return (
                            <p data-ws-agent-files-state={state} className="mt-1 flex flex-wrap items-center gap-2">
                                <span className={state === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--fg-2)]'}>{agentFilesLine(r)}</span>
                                <span className="text-[var(--fg-4)]">{agentFilesWhen(r)}</span>
                            </p>
                        );
                    })()}
                    {ops.agentFiles.results ? (
                        <ul className="mt-1 divide-y divide-[var(--border-1)]">
                            {ops.agentFiles.results.map((r) => (
                                <li key={r.id} data-sync-result={r.id} data-ok={r.ok ? 'true' : 'false'} className="flex items-center gap-3 py-1">
                                    <span>{r.label}</span>
                                    <Badge variant="soft" size="sm">{r.ok ? 'written' : 'failed'}</Badge>
                                    {r.error ? <span className="text-[var(--danger)]">{r.error}</span> : null}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </section>
            ) : null}
            {view === 'settings' && ops?.repos ? (
                <section data-repos className="shrink-0 border-b border-[var(--border-1)] px-5 py-2 text-xs">
                    <div className="flex items-center gap-3">
                        <h2 className="font-semibold">Repos</h2>
                        <span className="text-[var(--fg-4)]">the envelope's repositories; the host repo is the envelope itself</span>
                    </div>
                    {ops.repos.list === null ? (
                        <div data-repos-skeleton className="mt-2 flex flex-col gap-1">
                            <div className="h-3 w-1/3 animate-pulse rounded bg-[var(--bg-2)]" />
                            <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--bg-2)]" />
                        </div>
                    ) : (
                        <ul className="mt-1 divide-y divide-[var(--border-1)]">
                            {ops.repos.list.map((r) => (
                                <li key={r.slug} data-repo={r.slug} {...(r.host ? { 'data-repo-host': '' } : {})} className="flex items-center gap-3 py-1">
                                    <span className="font-medium">{r.slug}</span>
                                    <span className="font-mono text-[11px] text-[var(--fg-4)]">{r.path}</span>
                                    {r.host ? <span className="rounded bg-[var(--bg-2)] px-1 text-[10px] uppercase tracking-wide text-[var(--fg-3)]">host</span> : null}
                                    <span className="ml-auto" />
                                    <button type="button" data-action="open-repo" onClick={() => ops.repos!.onOpen(r.path)} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">Open</button>
                                    {!r.host ? <button type="button" data-action="remove-repo" data-repo-slug={r.slug} onClick={() => ops.repos!.onRemove(r.slug)} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">Remove</button> : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    <form data-form="add-repo" className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); ops.repos!.onAdd({ name: String(d.get('name') ?? ''), path: String(d.get('path') ?? '') }); e.currentTarget.reset(); }}>
                        <input name="name" placeholder="Name" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-0.5" />
                        <input name="path" placeholder="repos/<folder>" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-0.5 font-mono" />
                        <button type="submit" className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">Add repo</button>
                    </form>
                </section>
            ) : null}
            {panel === 'files' && files && !filesPinned && filesPopped ? (
                <div data-files-popped={workspace.id} className="flex shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-3 py-2 text-xs text-[var(--fg-3)]">
                    {/* THE POPPED-OUT BAR (the board): `external-link` · "<name> files are open in their own window." · the window's route in mono · `Bring back` (primary). */}
                    <Icon name="external-link" size="xs" />
                    <span>{workspace.name} files are open in their own window.</span>
                    <span data-files-window-route="" className="font-mono text-[11px] text-[var(--fg-4)]">{`genie://files/${workspace.id}`}</span>
                    {/* A second pop-out of a window already open FOCUSES it (`FilesWindows.popOut` re-opens the route): that is the board's `Focus window`. */}
                    {onPopOutFiles ? <button type="button" data-action="focus-files-window" onClick={() => onPopOutFiles()} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">Focus window</button> : null}
                    <button type="button" data-action="bring-back-files" onClick={() => onBringBackFiles?.()} className="rounded-md border border-[var(--primary-hover)] bg-[var(--primary)] px-2 py-0.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]">Bring back</button>
                </div>
            ) : null}
            {/* HOME — the board's workspace surface: the one file panel (when open) beside the agents rail. */}
            {view === 'home' ? (
                <div data-workspace-body="home" className="flex min-h-0 flex-1">
                    {filesInline && files ? (
                        <div className="min-h-0 min-w-0 flex-1">
                            <FilesPanelContainer workspace={workspace} files={files} pinned={false} onPin={() => onPinFiles?.()} onClose={() => onTogglePanel?.()} onPopOut={onPopOutFiles} onPause={onPauseAgent} onResume={onResumeAgent} routeFile={filesFile} routeLine={filesLine} routeFilter={filesFilter} onRouteChange={onFilesRoute} />
                        </div>
                    ) : null}
                    <WorkspaceHome name={label} workspaceId={workspace.id} view={home} wide={!filesInline} onOpenAgent={(id) => onOpenAgent?.(id)} onAddAgent={() => onAddAgent?.()} />
                </div>
            ) : null}
            {view === 'terminals' && filesInline && files ? (
                <div className="min-h-0 flex-1 border-b border-[var(--border-1)]">
                    <FilesPanelContainer workspace={workspace} files={files} pinned={false} onPin={() => onPinFiles?.()} onClose={() => onTogglePanel?.()} onPopOut={onPopOutFiles} onPause={onPauseAgent} onResume={onResumeAgent} onOpenInPane={(path) => setState((s) => codeOpened(s, path))} routeFile={filesFile} routeLine={filesLine} routeFilter={filesFilter} onRouteChange={onFilesRoute} />
                </div>
            ) : null}
            {view === 'terminals' ? terminalsBody : null}
            {/* GITHUB, THROUGH ISSUEWATCH (Tynn #806): what is open and what happened, for a workspace linked to Tynn. */}
            {view === 'github' && issueWatch ? <div className="min-h-0 flex-1 overflow-auto"><IssueWatchPanel view={issueWatch} /></div> : null}
            {/* A TAB YOU DESIGNED (Tynn #282): its grid of panels, designed in place. */}
            {view.startsWith('tab:') ? (() => {
                const tab = designed.tabs.find((t) => `tab:${t.id}` === view);
                if (!tab) {
                    return (
                        <div data-designed-tab-missing="" className="flex flex-1 flex-col items-center justify-center gap-2 text-[13px] text-[var(--fg-3)]">
                            <p>This tab is not in {label} any more.</p>
                            <button type="button" onClick={() => onViewChange?.('home')} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">Back to Agents</button>
                        </div>
                    );
                }
                return (
                    <DesignedTab
                        tab={tab}
                        notice={designNotice}
                        onLayout={(l) => { const r = setLayout(designed, tab.id, l); setDesignNotice(r.dropped.length > 0 ? `${r.dropped.length} panel${r.dropped.length === 1 ? '' : 's'} did not fit the new grid and ${r.dropped.length === 1 ? 'was' : 'were'} removed` : null); saveTabs(r.state); }}
                        onPlace={(cell, p) => saveTabs(placePanel(designed, tab.id, cell, p))}
                        onClear={(cell) => saveTabs(clearCell(designed, tab.id, cell))}
                        onRename={(name) => saveTabs(renameTab(designed, tab.id, name))}
                        onRemove={() => { saveTabs(removeTab(designed, tab.id)); onViewChange?.('home'); }}
                        renderPanel={(p) => {
                            if (p.kind === 'terminal') return terminalsBody;
                            if (p.kind === 'files') return files ? <FilesPanelContainer workspace={workspace} files={files} pinned={false} onPin={() => onPinFiles?.()} onClose={() => {}} onPause={onPauseAgent} onResume={onResumeAgent} /> : <p className="p-4 text-[12px] text-[var(--fg-3)]">This window has no file host.</p>;
                            if (p.kind === 'widget') return <WorkspaceHome name={label} workspaceId={workspace.id} view={home} wide onOpenAgent={(id) => onOpenAgent?.(id)} onAddAgent={() => onAddAgent?.()} />;
                            if (p.kind === 'artboard') {
                                const board = pluginPanels.find((pp) => pp.pluginId.includes('artboard'));
                                return board ? <PluginPane panel={board} /> : <p className="p-4 text-[12px] text-[var(--fg-3)]">The ArtBoard plugin is not enabled in this workspace.</p>;
                            }
                            return <SitePanel host={p.ref} onPick={(host) => { const at = tab.cells.indexOf(p); if (at >= 0) saveTabs(placePanel(designed, tab.id, at, { kind: 'site', ref: host })); }} />;
                        }}
                    />
                );
            })() : null}
        </section>
    );
}
