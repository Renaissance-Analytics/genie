import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import TerminalPanel from './TerminalPanel';
import ProcessPanel from './ProcessPanel';
import CodePanel from '../Code/CodePanel';
import { IconCode, IconPlus } from './icons';
import { api, type TerminalSpec, type WorkspaceRow } from '../../lib/genie';
import {
    buildPanelList,
    cellArea,
    dims,
    orderForMode,
    resolveMode,
    signature,
    type LayoutMode,
    type ResolvedMode,
} from '../../lib/terminal-grid-layout';

export type { LayoutMode } from '../../lib/terminal-grid-layout';

interface Props {
    /** Active-workspace specs only — these lay out the visible grid. */
    specs: TerminalSpec[];
    /**
     * Off-workspace selected specs. Rendered mounted-hidden (display:none)
     * so their PTYs survive a workspace switch (Decision 1: keep-alive).
     */
    backgroundSpecs?: TerminalSpec[];
    workspacesById: Map<string, WorkspaceRow>;
    /** Active workspace id — keys the persisted per-workspace track sizes. */
    activeWorkspaceId?: string | null;
    focusId: string | null;
    maximizedId: string | null;
    onClose: (id: string) => void;
    onFocus: (id: string) => void;
    onToggleMaximize: (id: string) => void;
    /** Tier 2: suspend a terminal (keep its pty alive, hide the panel). */
    onDisable?: (id: string) => void;
    onAddTerminal: () => void;
    onAddCode?: () => void;
    onMarkActive: (id: string) => void;
    onMarkInactive: (id: string) => void;
    layoutMode: LayoutMode;
    /** Disables the in-grid add tile (max_views reached). */
    addDisabled?: boolean;
    /** Tooltip shown on the disabled add tile. */
    addDisabledReason?: string;
}

const MIN_PANEL_PX = 160;
let LAYOUT_CACHE: Record<string, FrTracks> | null = null;

interface FrTracks {
    cols: number[];
    rows: number[];
}

/**
 * Layout grid for selected terminal specs.
 *
 * Critical invariant (the whole point of this component): EVERY selected
 * panel — the active workspace's AND every other workspace's — is rendered in
 * ONE keyed `.map()` inside ONE stable container. A panel's STYLE decides its
 * role (grid placement when active+visible; `display:none` when off-workspace
 * or hidden by a maximized sibling). Because no panel ever crosses array slots
 * or subtrees on a workspace switch, React reconciles each instance by its
 * stable key (= spec.id) and only mutates props — so xterm.js stays mounted and
 * the pty isn't re-spawned. (The previous split — active panels in one array
 * expression, background panels in a second — gave a crossing panel a different
 * effective key per slot, which forced an unmount/remount and reset the pty.)
 *
 * Layout still only mutates the parent's grid template + each child's
 * `gridArea`, so a LAYOUT switch is likewise mount-stable.
 *
 * Resizable: every split is draggable. The grid is modelled as N column
 * tracks × M row tracks of `fr` units; gutters between adjacent tracks
 * drag to redistribute the two neighbouring `fr` values. Track sizes
 * persist per workspace + panel-count signature via the `layout_json`
 * setting. Double-click a gutter resets that axis to even. Maximize hides
 * the gutters and gives the maximised panel the full area.
 */
export default function TerminalGrid({
    specs,
    backgroundSpecs = [],
    workspacesById,
    activeWorkspaceId,
    focusId,
    maximizedId,
    onClose,
    onFocus,
    onToggleMaximize,
    onDisable,
    onAddTerminal,
    onAddCode,
    onMarkActive,
    onMarkInactive,
    layoutMode,
    addDisabled,
    addDisabledReason,
}: Props) {
    // The resolved mode + ordering come from the ACTIVE workspace's visible
    // specs only. With an empty active workspace, `specs` is empty: mode is
    // 'g1', `ordered` is empty, and the unified list is all-background (every
    // entry display:none). The add-tiles render as an OVERLAY sibling so the
    // single keyed panel map stays mounted in the same parent — background
    // panels don't remount when switching to/from an empty workspace.
    const mode: ResolvedMode = resolveMode(layoutMode, specs.length);
    const ordered = orderForMode(mode, specs, focusId);
    const empty = specs.length === 0;
    const showAddTile = !empty && mode === '2x2' && ordered.length < 4;

    return (
        <ResizableGrid
            mode={mode}
            ordered={ordered}
            background={backgroundSpecs}
            empty={empty}
            workspacesById={workspacesById}
            activeWorkspaceId={activeWorkspaceId ?? null}
            focusId={focusId}
            maximizedId={maximizedId}
            onClose={onClose}
            onFocus={onFocus}
            onToggleMaximize={onToggleMaximize}
            onDisable={onDisable}
            onAddTerminal={onAddTerminal}
            onAddCode={onAddCode}
            onMarkActive={onMarkActive}
            onMarkInactive={onMarkInactive}
            showAddTile={showAddTile}
            addDisabled={addDisabled}
            addDisabledReason={addDisabledReason}
        />
    );
}

interface ResizableGridProps {
    mode: ResolvedMode;
    /** Active-workspace visible specs, ordered for the resolved mode. */
    ordered: TerminalSpec[];
    /** Off-workspace selected specs (kept mounted-hidden). */
    background: TerminalSpec[];
    /** True when the active workspace has no visible panels. */
    empty: boolean;
    workspacesById: Map<string, WorkspaceRow>;
    activeWorkspaceId: string | null;
    focusId: string | null;
    maximizedId: string | null;
    onClose: (id: string) => void;
    onFocus: (id: string) => void;
    onToggleMaximize: (id: string) => void;
    onDisable?: (id: string) => void;
    onAddTerminal: () => void;
    onAddCode?: () => void;
    onMarkActive: (id: string) => void;
    onMarkInactive: (id: string) => void;
    showAddTile: boolean;
    addDisabled?: boolean;
    addDisabledReason?: string;
}

function evenTracks(n: number): number[] {
    return Array.from({ length: n }, () => 1);
}

const ResizableGrid = ({
    mode,
    ordered,
    background,
    empty,
    workspacesById,
    activeWorkspaceId,
    focusId,
    maximizedId,
    onClose,
    onFocus,
    onToggleMaximize,
    onDisable,
    onAddTerminal,
    onAddCode,
    onMarkActive,
    onMarkInactive,
    showAddTile,
    addDisabled,
    addDisabledReason,
}: ResizableGridProps) => {
    const count = ordered.length;
    const { cols, rows } = dims(mode, count);
    const sig = signature(mode, count);
    const storageKey = `${activeWorkspaceId ?? 'none'}|${sig}`;

    const wrapRef = useRef<HTMLDivElement>(null);
    const [tracks, setTracks] = useState<FrTracks>(() => ({
        cols: evenTracks(cols),
        rows: evenTracks(rows),
    }));

    // Load persisted sizes (per workspace + signature) once the cache is
    // warm. A mismatched track length (e.g. saved under an older layout)
    // falls back to even so we never render a broken template.
    useEffect(() => {
        let alive = true;
        const apply = (cache: Record<string, FrTracks>) => {
            const saved = cache[storageKey];
            if (
                saved &&
                Array.isArray(saved.cols) &&
                Array.isArray(saved.rows) &&
                saved.cols.length === cols &&
                saved.rows.length === rows
            ) {
                if (alive) setTracks({ cols: [...saved.cols], rows: [...saved.rows] });
            } else if (alive) {
                setTracks({ cols: evenTracks(cols), rows: evenTracks(rows) });
            }
        };
        if (LAYOUT_CACHE) {
            apply(LAYOUT_CACHE);
        } else {
            void api()
                .settings.get()
                .then((s) => {
                    let parsed: Record<string, FrTracks> = {};
                    try {
                        parsed = s.layout_json ? JSON.parse(s.layout_json) : {};
                    } catch {
                        parsed = {};
                    }
                    LAYOUT_CACHE = parsed;
                    apply(parsed);
                })
                .catch(() => {
                    LAYOUT_CACHE = {};
                    apply({});
                });
        }
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey, cols, rows]);

    const persist = useCallback(
        (next: FrTracks) => {
            const cache = LAYOUT_CACHE ?? {};
            cache[storageKey] = { cols: [...next.cols], rows: [...next.rows] };
            LAYOUT_CACHE = cache;
            void api()
                .settings.set({ layout_json: JSON.stringify(cache) })
                .catch(() => {});
        },
        [storageKey],
    );

    /**
     * Drag a gutter on `axis` between track `index` and `index+1`. The
     * pixel delta is converted to `fr` against the measured container
     * extent; both neighbours are clamped so neither drops below the
     * minimum panel size.
     */
    const startDrag = useCallback(
        (
            axis: 'cols' | 'rows',
            index: number,
            e: ReactPointerEvent<HTMLDivElement>,
        ) => {
            e.preventDefault();
            e.stopPropagation();
            const wrap = wrapRef.current;
            if (!wrap) return;
            const rect = wrap.getBoundingClientRect();
            const horizontal = axis === 'cols';
            const extent = horizontal ? rect.width : rect.height;
            if (extent <= 0) return;

            const start = horizontal ? e.clientX : e.clientY;
            const base = tracks[axis];
            const a0 = base[index];
            const b0 = base[index + 1];
            const sumFr = a0 + b0;
            // Px-per-fr for this pair: the two tracks share `pairPx` pixels.
            const totalFr = base.reduce((x, y) => x + y, 0);
            const pairPx = (sumFr / totalFr) * extent;
            const minFr = totalFr > 0 ? (MIN_PANEL_PX / extent) * totalFr : 0;

            const onMove = (ev: PointerEvent) => {
                const cur = horizontal ? ev.clientX : ev.clientY;
                const deltaPx = cur - start;
                const deltaFr = (deltaPx / pairPx) * sumFr;
                let a = a0 + deltaFr;
                let b = b0 - deltaFr;
                if (a < minFr) {
                    a = minFr;
                    b = sumFr - minFr;
                }
                if (b < minFr) {
                    b = minFr;
                    a = sumFr - minFr;
                }
                setTracks((prev) => {
                    const arr = [...prev[axis]];
                    arr[index] = a;
                    arr[index + 1] = b;
                    return { ...prev, [axis]: arr };
                });
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                document.body.classList.remove('gutter-dragging');
                setTracks((prev) => {
                    persist(prev);
                    return prev;
                });
            };
            document.body.classList.add('gutter-dragging');
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        },
        [tracks, persist],
    );

    const resetAxis = useCallback(
        (axis: 'cols' | 'rows') => {
            setTracks((prev) => {
                const next = {
                    ...prev,
                    [axis]: evenTracks(prev[axis].length),
                };
                persist(next);
                return next;
            });
        },
        [persist],
    );

    const maximized = maximizedId !== null;

    // Build the grid template. focus-stack collapses the column-2 cells
    // into `rows` row tracks; the rectangular modes are a plain cols×rows.
    const gridStyle: CSSProperties = {
        display: 'grid',
        gridTemplateColumns: tracks.cols.map((f) => `${f}fr`).join(' '),
        gridTemplateRows: tracks.rows.map((f) => `${f}fr`).join(' '),
        gap: '1px',
    };

    // THE UNIFIED LIST: active visible panels (with grid placement) followed
    // by every off-workspace panel (display:none), all in ONE stably-ordered
    // array. We render it through ONE keyed `.map()` below so no instance ever
    // unmounts on a workspace switch (see the component-level comment).
    const panels = buildPanelList({
        ordered,
        background,
        mode,
        maximizedId,
    });

    return (
        <div className="grid-wrap">
            <div ref={wrapRef} className="pgrid resizable" style={gridStyle}>
                {panels.map((p) => (
                    <PanelFor
                        key={p.spec.id}
                        spec={p.spec}
                        workspacesById={workspacesById}
                        focused={p.visible && focusId === p.spec.id}
                        maximized={p.isMaximized}
                        style={p.style}
                        onClose={() => onClose(p.spec.id)}
                        onMaximize={() => onToggleMaximize(p.spec.id)}
                        onMinimize={
                            p.isMainInStack ? () => onFocus(p.spec.id) : undefined
                        }
                        onDisable={onDisable ? () => onDisable(p.spec.id) : undefined}
                        onMarkActive={() => onMarkActive(p.spec.id)}
                        onMarkInactive={() => onMarkInactive(p.spec.id)}
                    />
                ))}
                {/* 2×2 add-tile: a non-panel child, AFTER the single panel map so
                    it never re-splits the panel array. */}
                {showAddTile && !maximized && (
                    <button
                        type="button"
                        className="addtile"
                        onClick={onAddTerminal}
                        disabled={addDisabled}
                        title={addDisabled ? addDisabledReason : undefined}
                        style={cellArea('2x2', count, 4)}
                    >
                        <span className="ai">
                            <IconPlus size={18} />
                        </span>
                        <span className="at">Add Terminal</span>
                        <span className="as">from any project — pick on the left</span>
                    </button>
                )}
                {!empty && !maximized && (
                    <Gutters
                        mode={mode}
                        cols={cols}
                        rows={rows}
                        onStart={startDrag}
                        onReset={resetAxis}
                    />
                )}
            </div>
            {/* Empty-active-workspace state: the Add Terminal / Add Editor tiles
                render as an OVERLAY over the (all-hidden) panel grid. Critically
                the panel `.map()` above stays mounted in the SAME parent, so the
                off-workspace background panels don't remount when switching
                to/from an empty workspace. */}
            {empty && (
                <div className="addtile-overlay">
                    <div className="addtile-group">
                        <button
                            type="button"
                            className="addtile"
                            onClick={onAddTerminal}
                            disabled={addDisabled}
                            title={addDisabled ? addDisabledReason : undefined}
                        >
                            <span className="ai">
                                <IconPlus size={18} />
                            </span>
                            <span className="at">Add Terminal</span>
                            <span className="as">a live shell in this workspace</span>
                        </button>
                        {onAddCode && (
                            <button
                                type="button"
                                className="addtile"
                                onClick={onAddCode}
                                disabled={addDisabled}
                                title={addDisabled ? addDisabledReason : undefined}
                            >
                                <span className="ai">
                                    <IconCode size={18} />
                                </span>
                                <span className="at">Add Editor</span>
                                <span className="as">
                                    browse + edit files in this workspace
                                </span>
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * The drag handles. Each gutter spans the seam between two adjacent tracks
 * and lays over the grid. A `~6px` visible bar inside a `~12px` hit area
 * (the `::before` paints the bar; the element itself is the hit target).
 *
 *   - Column gutters: full grid height, between column i and i+1.
 *   - Row gutters: full grid width, between row j and j+1 — EXCEPT in
 *     focus-stack, where row gutters live in column 2 only (the stack),
 *     since the main panel in column 1 spans every row.
 */
function Gutters({
    mode,
    cols,
    rows,
    onStart,
    onReset,
}: {
    mode: ResolvedMode;
    cols: number;
    rows: number;
    onStart: (
        axis: 'cols' | 'rows',
        index: number,
        e: ReactPointerEvent<HTMLDivElement>,
    ) => void;
    onReset: (axis: 'cols' | 'rows') => void;
}) {
    const handles: React.ReactNode[] = [];

    // Vertical (column) gutters — full height, sit on each column seam.
    for (let i = 0; i < cols - 1; i++) {
        handles.push(
            <div
                key={`c${i}`}
                className="grid-gutter gutter-col"
                style={{
                    gridColumn: `${i + 1} / ${i + 2}`,
                    gridRow: '1 / -1',
                    justifySelf: 'end',
                }}
                onPointerDown={(e) => onStart('cols', i, e)}
                onDoubleClick={() => onReset('cols')}
                title="Drag to resize · double-click to reset"
            />,
        );
    }

    // Horizontal (row) gutters.
    if (mode === 'focus-stack') {
        // Row seams live in column 2 only (the stack). Main panel spans all
        // rows in column 1, so a full-width row gutter would cross it.
        for (let j = 0; j < rows - 1; j++) {
            handles.push(
                <div
                    key={`r${j}`}
                    className="grid-gutter gutter-row"
                    style={{
                        gridColumn: '2 / 3',
                        gridRow: `${j + 1} / ${j + 2}`,
                        alignSelf: 'end',
                    }}
                    onPointerDown={(e) => onStart('rows', j, e)}
                    onDoubleClick={() => onReset('rows')}
                    title="Drag to resize · double-click to reset"
                />,
            );
        }
    } else {
        for (let j = 0; j < rows - 1; j++) {
            handles.push(
                <div
                    key={`r${j}`}
                    className="grid-gutter gutter-row"
                    style={{
                        gridColumn: '1 / -1',
                        gridRow: `${j + 1} / ${j + 2}`,
                        alignSelf: 'end',
                    }}
                    onPointerDown={(e) => onStart('rows', j, e)}
                    onDoubleClick={() => onReset('rows')}
                    title="Drag to resize · double-click to reset"
                />,
            );
        }
    }

    return <>{handles}</>;
}

interface PanelForProps {
    spec: TerminalSpec;
    workspacesById: Map<string, WorkspaceRow>;
    focused: boolean;
    maximized: boolean;
    style: CSSProperties;
    onClose: () => void;
    onMaximize: () => void;
    onMinimize?: () => void;
    onDisable?: () => void;
    onMarkActive: () => void;
    onMarkInactive: () => void;
}

/**
 * Dispatch a spec to the right panel component by `spec.type`. A 'code'
 * spec renders the fancy-code editor view; everything else is a terminal.
 */
function PanelFor({
    spec,
    workspacesById,
    focused,
    maximized,
    style,
    onClose,
    onMaximize,
    onMinimize,
    onDisable,
    onMarkActive,
    onMarkInactive,
}: PanelForProps) {
    const workspace = spec.workspace_id
        ? workspacesById.get(spec.workspace_id)
        : undefined;

    if (spec.type === 'code') {
        return (
            <CodePanel
                spec={spec}
                workspace={workspace}
                focused={focused}
                maximized={maximized}
                style={style}
                onClose={onClose}
                onMaximize={onMaximize}
                onMinimize={onMinimize}
            />
        );
    }

    if (spec.type === 'process') {
        return (
            <ProcessPanel
                spec={spec}
                workspace={workspace}
                focused={focused}
                maximized={maximized}
                style={style}
                onClose={onClose}
                onMaximize={onMaximize}
                onMinimize={onMinimize}
                onMarkActive={onMarkActive}
                onMarkInactive={onMarkInactive}
            />
        );
    }

    return (
        <TerminalPanel
            spec={spec}
            workspace={workspace}
            focused={focused}
            maximized={maximized}
            style={style}
            onClose={onClose}
            onMaximize={onMaximize}
            onMinimize={onMinimize}
            onDisable={onDisable}
            onMarkActive={onMarkActive}
            onMarkInactive={onMarkInactive}
        />
    );
}
