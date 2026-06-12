import { useCallback, useEffect, useMemo, useState } from 'react';
import Chooser from '../components/Master/Chooser';
import ProjectContextMenu from '../components/Master/ProjectContextMenu';
import ProjectSelector from '../components/Master/ProjectSelector';
import SpecContextMenu from '../components/Master/SpecContextMenu';
import { PromptHost, showPrompt } from '../components/Master/Prompt';
import TerminalGrid, {
    type LayoutMode,
} from '../components/Master/TerminalGrid';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import SignInPrompt from '../components/SignInPrompt';
import type { BackendUser } from '../lib/genie';
import {
    IconBox,
    IconColumns,
    IconLayoutGrid,
    IconListTree,
    IconMaximize,
    IconPanelLeft,
    IconPlus,
    IconSettings,
} from '../components/Master/icons';
import {
    api,
    hasGenieBridge,
    ulid,
    type TerminalSpec,
    type UpdaterStatus,
    type WorkspaceRow,
} from '../lib/genie';

/**
 * Master workspace — cross-project terminal organiser. Hosts the
 * chooser tree (Pinned · Custom views · Projects), the panel grid
 * (auto-layout based on selected count) and the chrome bars.
 *
 * State strategy:
 *   - `workspaces` + `specs` come from main on mount, refreshed when we
 *     mutate something.
 *   - `selected` is in-memory only (a "view" the user is currently
 *     composing). Persisted custom views are a v2 feature.
 *   - `activeIds` reflects which selected spec has a live pty. We track
 *     this in renderer state because the TerminalManager is per-window;
 *     a panel goes "active" once XTerm mounts and "inactive" on exit.
 */
export default function MasterPage() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        if (hasGenieBridge()) {
            setReady(true);
            return;
        }
        const t = setInterval(() => {
            if (hasGenieBridge()) {
                setReady(true);
                clearInterval(t);
            }
        }, 100);
        return () => clearInterval(t);
    }, []);

    if (!ready) {
        return (
            <div
                style={{
                    minHeight: '100vh',
                    display: 'grid',
                    placeItems: 'center',
                    background: '#0a0a0c',
                    color: '#a1a1aa',
                    fontSize: 13,
                }}
            >
                Waiting for preload bridge…
            </div>
        );
    }

    return <MasterInner />;
}

function MasterInner() {
    const [authChecked, setAuthChecked] = useState(false);
    const [signedIn, setSignedIn] = useState(false);
    const [hosts, setHosts] = useState<{ tynn: string; aionima: string }>({
        tynn: 'https://tynn.ai',
        aionima: '',
    });
    const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
    const [specs, setSpecs] = useState<TerminalSpec[]>([]);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());
    const [focusId, setFocusId] = useState<string | null>(null);
    const [maximizedId, setMaximizedId] = useState<string | null>(null);
    const [chooserPinned, setChooserPinned] = useState(true);
    const [layoutMode, setLayoutMode] = useState<LayoutMode>('auto');
    const [contextMenu, setContextMenu] = useState<{
        specId: string;
        x: number;
        y: number;
    } | null>(null);
    const [projectMenu, setProjectMenu] = useState<{
        workspaceId: string;
        x: number;
        y: number;
    } | null>(null);
    const [addingWorkspace, setAddingWorkspace] = useState(false);

    const workspacesById = useMemo(() => {
        const m = new Map<string, WorkspaceRow>();
        for (const w of workspaces) m.set(w.id, w);
        return m;
    }, [workspaces]);

    const refresh = useCallback(async () => {
        const [ws, sp] = await Promise.all([
            api().workspaces.list(),
            api().terminalSpec.list(),
        ]);
        setWorkspaces(ws);
        setSpecs(sp);
    }, []);

    // Stage windows arrive with ?stage=<workspaceId>. Read it once on mount
    // and seed the selection with that workspace's terminals so the user
    // sees something useful immediately.
    const isStage = useMemo(() => {
        if (typeof window === 'undefined') return false;
        const p = new URLSearchParams(window.location.search);
        return p.has('stage');
    }, []);
    const stageSeedWorkspace = useMemo(() => {
        if (typeof window === 'undefined') return null;
        const p = new URLSearchParams(window.location.search);
        const v = p.get('stage');
        return v && v !== '1' ? v : null;
    }, []);

    const refreshAuth = useCallback(async () => {
        const [t, a, tHost, aHostInfo] = await Promise.all([
            api().auth.whoami('tynn'),
            api().auth.whoami('aionima'),
            api().tynnHost.get(),
            api().aionima.hostInfo(),
        ]);
        setHosts({ tynn: tHost, aionima: aHostInfo });
        const any = !!(t as BackendUser | null) || !!(a as BackendUser | null);
        setSignedIn(any);
        return any;
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const any = await refreshAuth();
            if (cancelled) return;
            setAuthChecked(true);
            if (any) await refresh();
        })();
        const off = api().on.authChanged(async () => {
            const any = await refreshAuth();
            if (any) await refresh();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [refresh, refreshAuth]);

    useEffect(() => {
        if (!stageSeedWorkspace || specs.length === 0 || selected.size > 0) return;
        const ids = specs
            .filter((s) => s.workspace_id === stageSeedWorkspace)
            .map((s) => s.id);
        if (ids.length > 0) setSelected(new Set(ids));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [specs.length, stageSeedWorkspace]);

    const selectedSpecs = useMemo(
        () => specs.filter((s) => selected.has(s.id)),
        [specs, selected],
    );

    const toggleSpec = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const addSpec = useCallback(
        async (workspaceId: string) => {
            const ws = workspacesById.get(workspaceId);
            if (!ws) return;
            const existing = specs.filter((s) => s.workspace_id === workspaceId);
            const baseLabel = ws.project_name.toLowerCase().replace(/\s+/g, '-');
            const label = existing.length === 0 ? baseLabel : `${baseLabel}-${existing.length + 1}`;
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: workspaceId,
                label,
                cwd: ws.path,
            });
            // Append the new spec in place rather than re-fetching the full
            // list — refresh() would replace the array reference, which makes
            // the panels' parent re-render. Existing TerminalPanels stay keyed
            // by their spec id so they don't unmount, but minimising churn
            // here keeps the new-panel-while-others-running path smooth.
            setSpecs((prev) => [...prev, created]);
            setSelected((prev) => new Set(prev).add(created.id));
        },
        [specs, workspacesById],
    );

    const closeSelected = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setActiveIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setFocusId((cur) => (cur === id ? null : cur));
        setMaximizedId((cur) => (cur === id ? null : cur));
    }, []);

    const destroySpec = useCallback(async (id: string) => {
        // Optimistic: drop from local state first so the panel unmounts
        // (which kills the pty via XTerm's cleanup), then DB-delete. If
        // the DB call fails, refresh() on next mount brings it back —
        // worst case the user sees a deleted spec reappear.
        setSelected((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setActiveIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setFocusId((cur) => (cur === id ? null : cur));
        setMaximizedId((cur) => (cur === id ? null : cur));
        setSpecs((prev) => prev.filter((s) => s.id !== id));
        try {
            await api().terminalSpec.remove(id);
        } catch (e) {
            console.error('Failed to delete terminal spec', e);
        }
    }, []);

    const toggleMaximize = useCallback((id: string) => {
        setMaximizedId((cur) => (cur === id ? null : id));
    }, []);

    const switchToProject = useCallback(
        (workspaceId: string) => {
            const ids = specs
                .filter((s) => s.workspace_id === workspaceId)
                .map((s) => s.id);
            setSelected(new Set(ids));
            setFocusId(null);
            setMaximizedId(null);
        },
        [specs],
    );

    const showAllTerminals = useCallback(() => {
        setSelected(new Set(specs.map((s) => s.id)));
        setFocusId(null);
        setMaximizedId(null);
    }, [specs]);

    const clearSelection = useCallback(() => {
        setSelected(new Set());
        setFocusId(null);
        setMaximizedId(null);
    }, []);

    const renameSpec = useCallback(async (id: string, currentLabel: string) => {
        const next = await showPrompt({
            title: 'Rename terminal',
            label: 'New name',
            initial: currentLabel,
            placeholder: 'e.g. dev:vite',
            confirmLabel: 'Rename',
        });
        const trimmed = next?.trim();
        if (!trimmed || trimmed === currentLabel) return;
        const updated = await api().terminalSpec.update(id, { label: trimmed });
        if (updated) {
            setSpecs((prev) =>
                prev.map((s) => (s.id === id ? { ...s, label: trimmed } : s)),
            );
        }
    }, []);

    const duplicateSpec = useCallback(
        async (id: string) => {
            const src = specs.find((s) => s.id === id);
            if (!src) return;
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: src.workspace_id,
                label: `${src.label}-copy`,
                cwd: src.cwd,
                shell: src.shell ?? null,
                args: src.args,
                env: src.env,
            });
            setSpecs((prev) => [...prev, created]);
            setSelected((prev) => new Set(prev).add(created.id));
        },
        [specs],
    );

    const moveSpecToWorkspace = useCallback(
        async (id: string, workspaceId: string | null) => {
            const updated = await api().terminalSpec.update(id, {
                workspace_id: workspaceId,
            });
            if (updated) {
                setSpecs((prev) =>
                    prev.map((s) =>
                        s.id === id ? { ...s, workspace_id: workspaceId } : s,
                    ),
                );
            }
        },
        [],
    );

    const openSpecInNewWindow = useCallback((id: string) => {
        // Pop-out window is a stretch goal — for now the action just makes
        // sure the spec is in the current selection and maximises it so the
        // user sees the panel even if it was hidden.
        setSelected((prev) => new Set(prev).add(id));
        setMaximizedId(id);
    }, []);

    const openProjectInStage = useCallback((workspaceId: string) => {
        void api().app.openStage(workspaceId);
    }, []);

    const openProjectInBrowser = useCallback(
        (workspaceId: string) => {
            const ws = workspacesById.get(workspaceId);
            if (!ws) return;
            void api().tynn.openInBrowser('/dashboard', ws.backend);
        },
        [workspacesById],
    );

    const removeWorkspaceRow = useCallback(async (workspaceId: string) => {
        const ok = await showPrompt({
            title: 'Remove project from Genie',
            body: 'The folder on disk is not touched. Any terminal specs attached to it will become unattached.',
            confirmLabel: 'Remove',
            destructive: true,
        });
        if (ok === null) return;
        await api().workspaces.remove(workspaceId);
        await refresh();
    }, [refresh]);

    const markActive = useCallback((id: string) => {
        setActiveIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }, []);
    const markInactive = useCallback((id: string) => {
        setActiveIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }, []);

    const projectsActive = useMemo(() => {
        const ids = new Set<string>();
        for (const s of selectedSpecs) if (s.workspace_id) ids.add(s.workspace_id);
        return ids;
    }, [selectedSpecs]);

    if (authChecked && !signedIn) {
        return (
            <div className="gwrap" id="app">
                <div className="winframe">
                    <TitleBar isStage={false} />
                    <div
                        style={{
                            flex: 1,
                            minHeight: 0,
                            display: 'grid',
                            placeItems: 'center',
                            background: 'var(--bg-0)',
                        }}
                    >
                        <div style={{ maxWidth: 720, width: '100%' }}>
                            <SignInPrompt
                                tynnHost={hosts.tynn}
                                aionimaHost={hosts.aionima}
                                onSignedIn={async () => {
                                    await refreshAuth();
                                    await refresh();
                                }}
                            />
                        </div>
                    </div>
                </div>
                <PromptHost />
            </div>
        );
    }

    if (!authChecked) {
        return (
            <div
                style={{
                    minHeight: '100vh',
                    display: 'grid',
                    placeItems: 'center',
                    background: '#0a0a0c',
                    color: '#a1a1aa',
                    fontSize: 13,
                }}
            >
                Checking sign-in…
            </div>
        );
    }

    return (
        <div className="gwrap" id="app">
            <div className="winframe">
                <TitleBar
                    isStage={isStage}
                    stageWorkspaceName={
                        stageSeedWorkspace
                            ? workspacesById.get(stageSeedWorkspace)?.project_name
                            : undefined
                    }
                />
                <UpdateBanner />
                <Toolbar
                    workspaces={workspaces}
                    specs={specs}
                    selected={selected}
                    workspacesById={workspacesById}
                    layoutMode={layoutMode}
                    onLayoutMode={setLayoutMode}
                    onAddTerminal={() => workspaces[0] && void addSpec(workspaces[0].id)}
                    onSwitchToProject={switchToProject}
                    onShowAll={showAllTerminals}
                    onClear={clearSelection}
                />
                <div className="gbody">
                    <Chooser
                        workspaces={workspaces}
                        specs={specs}
                        selected={selected}
                        activeIds={activeIds}
                        pinned={chooserPinned}
                        onTogglePin={() => setChooserPinned((p) => !p)}
                        onToggleSpec={toggleSpec}
                        onAddSpec={(wsId) => void addSpec(wsId)}
                        onDestroySpec={(id) => void destroySpec(id)}
                        onOpenContextMenu={(specId, p) =>
                            setContextMenu({ specId, x: p.x, y: p.y })
                        }
                        onOpenProjectMenu={(wsId, p) =>
                            setProjectMenu({ workspaceId: wsId, x: p.x, y: p.y })
                        }
                        onAddWorkspace={() => setAddingWorkspace(true)}
                    />
                    <TerminalGrid
                        specs={selectedSpecs}
                        workspacesById={workspacesById}
                        focusId={focusId}
                        maximizedId={maximizedId}
                        onClose={closeSelected}
                        onFocus={(id) => setFocusId((cur) => (cur === id ? null : id))}
                        onToggleMaximize={toggleMaximize}
                        onAddTerminal={() =>
                            workspaces[0] && void addSpec(workspaces[0].id)
                        }
                        onMarkActive={markActive}
                        onMarkInactive={markInactive}
                        layoutMode={layoutMode}
                    />
                </div>
                <StatusBar
                    panelCount={selectedSpecs.length}
                    projectCount={projectsActive.size}
                    activeCount={activeIds.size}
                />
            </div>

            <PromptHost />

            {addingWorkspace && (
                <AddWorkspaceModal
                    onClose={() => setAddingWorkspace(false)}
                    onAdded={(row) => {
                        setWorkspaces((prev) => {
                            const exists = prev.some((w) => w.id === row.id);
                            return exists
                                ? prev.map((w) => (w.id === row.id ? row : w))
                                : [...prev, row];
                        });
                        setAddingWorkspace(false);
                    }}
                />
            )}

            {projectMenu && (() => {
                const ws = workspacesById.get(projectMenu.workspaceId);
                if (!ws) return null;
                return (
                    <ProjectContextMenu
                        position={{ x: projectMenu.x, y: projectMenu.y }}
                        workspace={ws}
                        onClose={() => setProjectMenu(null)}
                        onAddTerminal={() => void addSpec(ws.id)}
                        onOpenStage={() => openProjectInStage(ws.id)}
                        onOpenInBrowser={() => openProjectInBrowser(ws.id)}
                        onRemove={() => void removeWorkspaceRow(ws.id)}
                    />
                );
            })()}

            {contextMenu && (() => {
                const target = specs.find((s) => s.id === contextMenu.specId);
                if (!target) return null;
                return (
                    <SpecContextMenu
                        position={{ x: contextMenu.x, y: contextMenu.y }}
                        spec={target}
                        inSelection={selected.has(target.id)}
                        workspaces={workspaces}
                        onClose={() => setContextMenu(null)}
                        onToggleInView={() => toggleSpec(target.id)}
                        onOpenInNewWindow={() => openSpecInNewWindow(target.id)}
                        onRename={() => void renameSpec(target.id, target.label)}
                        onDuplicate={() => void duplicateSpec(target.id)}
                        onMoveToWorkspace={(wsId) =>
                            void moveSpecToWorkspace(target.id, wsId)
                        }
                        onDelete={async () => {
                            const ok = await showPrompt({
                                title: 'Delete terminal',
                                body: `Delete "${target.label}"? Its saved spec is removed and any running shell is killed.`,
                                confirmLabel: 'Delete',
                                destructive: true,
                            });
                            if (ok !== null) void destroySpec(target.id);
                        }}
                    />
                );
            })()}
        </div>
    );
}

/**
 * Slim update strip under the title bar. Renders only while an update is
 * pending (available → downloading/applying → ready-to-restart) and the
 * user hasn't dismissed THAT version — a new release re-surfaces it. The
 * action button walks the updater's own state machine: download/apply
 * first, restart once staged.
 */
function UpdateBanner() {
    const [status, setStatus] = useState<UpdaterStatus | null>(null);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        void api()
            .updater.status()
            .then((s) => alive && setStatus(s))
            .catch(() => {});
        const off = api().on.updaterStatus((s) => setStatus(s));
        return () => {
            alive = false;
            off();
        };
    }, []);

    const pending =
        status &&
        ['available', 'downloading', 'applying', 'ready-to-restart'].includes(
            status.state,
        );
    if (!status || !pending) return null;
    if (dismissed && dismissed === status.latestVersion) return null;

    const version = status.latestVersion ?? 'new version';
    const working = status.state === 'downloading' || status.state === 'applying';
    const pct =
        status.state === 'downloading' && typeof status.progress === 'number'
            ? ` ${Math.round(status.progress * 100)}%`
            : '';

    const act = async () => {
        setBusy(true);
        try {
            if (status.state === 'available') {
                await api().updater.apply();
            } else if (status.state === 'ready-to-restart') {
                const r = await api().updater.restart();
                // Phase-1 (git checkout) builds restart manually — quitting
                // is the honest fallback so relaunch picks up the new code.
                if (!r.ok) await api().app.quit();
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="update-banner">
            <span className="ub-dot" />
            <span className="ub-text">
                {status.state === 'ready-to-restart'
                    ? `Genie v${version} is ready — restart to finish installing.`
                    : working
                        ? `Downloading Genie v${version}…${pct}`
                        : `Genie v${version} is available.`}
            </span>
            <span className="ub-spacer" />
            {!working && (
                <button type="button" className="ub-btn" onClick={act} disabled={busy}>
                    {status.state === 'ready-to-restart'
                        ? 'Restart now'
                        : 'Download update'}
                </button>
            )}
            <button
                type="button"
                className="ub-close"
                title="Dismiss for this version"
                onClick={() => setDismissed(status.latestVersion ?? 'unknown')}
            >
                ×
            </button>
        </div>
    );
}

function TitleBar({
    isStage,
    stageWorkspaceName,
}: {
    isStage: boolean;
    stageWorkspaceName?: string;
}) {
    const isMac =
        typeof navigator !== 'undefined' &&
        /Mac/i.test(navigator.platform ?? navigator.userAgent ?? '');
    return (
        <div className="titlebar">
            {/* The native title bar is hidden (titleBarStyle: 'hidden') — this
                row IS the window chrome. On macOS the REAL traffic lights
                overlay the top-left corner, so pad past them rather than
                painting fakes. */}
            {isMac && <span className="traffic-pad" />}
            <span className="glogo">
                {/* The PNG ships in resources/logo.png; Next copies it into
                    renderer/public at build time. Use the relative path so it
                    works under file:// (packaged) and http://localhost (dev). */}
                <img className="lamp" src="./logo.png" alt="" width={22} height={22} />
                Genie
            </span>
            {/* No internal view codenames in the UI — a Stage window shows its
                pinned workspace name, the master window shows nothing extra. */}
            {isStage && stageWorkspaceName && (
                <span className="ttl">{stageWorkspaceName}</span>
            )}
            <span className="spacer" />
            <button
                type="button"
                className="gicon"
                title="Settings"
                onClick={() => api().app.showSettings().catch(() => {})}
            >
                <IconSettings />
            </button>
        </div>
    );
}

interface ToolbarProps {
    workspaces: WorkspaceRow[];
    specs: TerminalSpec[];
    selected: Set<string>;
    workspacesById: Map<string, WorkspaceRow>;
    layoutMode: LayoutMode;
    onLayoutMode: (m: LayoutMode) => void;
    onAddTerminal: () => void;
    onSwitchToProject: (workspaceId: string) => void;
    onShowAll: () => void;
    onClear: () => void;
}

function Toolbar({
    workspaces,
    specs,
    selected,
    workspacesById,
    layoutMode,
    onLayoutMode,
    onAddTerminal,
    onSwitchToProject,
    onShowAll,
    onClear,
}: ToolbarProps) {
    return (
        <div className="gtoolbar">
            <ProjectSelector
                workspaces={workspaces}
                specs={specs}
                selected={selected}
                workspacesById={workspacesById}
                onSwitchToProject={onSwitchToProject}
                onShowAll={onShowAll}
                onClear={onClear}
            />
            <span className="spacer" />
            <div className="seg">
                <button
                    type="button"
                    className={layoutMode === 'auto' ? 'on' : ''}
                    onClick={() => onLayoutMode('auto')}
                    title="Auto layout"
                >
                    <IconLayoutGrid />
                </button>
                <button
                    type="button"
                    className={layoutMode === 'focus-stack' ? 'on' : ''}
                    onClick={() => onLayoutMode('focus-stack')}
                    title="Focus + stack"
                >
                    <IconPanelLeft />
                </button>
                <button
                    type="button"
                    className={layoutMode === '2x2' ? 'on' : ''}
                    onClick={() => onLayoutMode('2x2')}
                    title="2×2 grid"
                >
                    <IconLayoutGrid />
                </button>
                <button
                    type="button"
                    className={layoutMode === 'columns' ? 'on' : ''}
                    onClick={() => onLayoutMode('columns')}
                    title="3 columns"
                >
                    <IconColumns />
                </button>
            </div>
            <button type="button" className="gicon" title="Maximize window">
                <IconMaximize />
            </button>
            <button type="button" className="gbtn accent" onClick={onAddTerminal}>
                <IconPlus /> Add terminal
            </button>
        </div>
    );
}

interface StatusBarProps {
    panelCount: number;
    projectCount: number;
    activeCount: number;
}

function StatusBar({ panelCount, projectCount, activeCount }: StatusBarProps) {
    return (
        <div className="gstatus">
            <span className="si">
                <IconLayoutGrid size={13} /> {panelCount} panel
                {panelCount === 1 ? '' : 's'}
            </span>
            <span className="si">
                <IconBox size={13} />
                {projectCount === 0
                    ? 'No project'
                    : projectCount === 1
                      ? '1 project'
                      : `${projectCount} projects`}
            </span>
            <span className="si">
                <span className="sdot" style={{ background: '#10b981' }} />
                {activeCount} live
            </span>
            <span className="spacer" />
            <span className="si mono">⌘1–9 focus · ⌘\ pin tree · ⌘W close panel</span>
        </div>
    );
}
