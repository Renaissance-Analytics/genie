import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import TerminalPanel from './TerminalPanel';
import CodePanel from '../Code/CodePanel';
import { IconCode, IconPlus } from './icons';
import { api, type TerminalSpec, type WorkspaceRow } from '../../lib/genie';

export type LayoutMode = 'auto' | 'focus-stack' | '2x2' | 'columns';

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

type ResolvedMode = 'g1' | 'g2x1' | 'focus-stack' | '2x2' | 'columns';

const MIN_PANEL_PX = 160;
const GUTTER_HIT = 12; // px hit area
let LAYOUT_CACHE: Record<string, FrTracks> | null = null;

interface FrTracks {
    cols: number[];
    rows: number[];
}

/**
 * Layout grid for selected terminal specs.
 *
 * Critical invariant: every panel sits as a direct child of the single
 * `.pgrid` container in every mode. Layout changes only mutate the
 * parent's grid template + each child's `gridArea`. React reconciliation
 * keeps each panel mounted by key (= spec.id), so xterm.js stays alive and
 * the pty isn't re-spawned on a layout switch.
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
    // Off-workspace selected panels: mounted but hidden so their PTYs keep
    // running across a workspace switch.
    const background = backgroundSpecs.map((spec) => (
        <PanelFor
            key={spec.id}
            spec={spec}
            workspacesById={workspacesById}
            focused={false}
            maximized={false}
            style={{ display: 'none' }}
            onClose={() => onClose(spec.id)}
            onMaximize={() => onToggleMaximize(spec.id)}
            onDisable={onDisable ? () => onDisable(spec.id) : undefined}
            onMarkActive={() => onMarkActive(spec.id)}
            onMarkInactive={() => onMarkInactive(spec.id)}
        />
    ));

    if (specs.length === 0) {
        return (
            <div className="grid-wrap">
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
                        <span className="at">Add a terminal</span>
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
                            <span className="at">Add a code view</span>
                            <span className="as">
                                browse + edit files in this workspace
                            </span>
                        </button>
                    )}
                </div>
                <div style={{ display: 'none' }}>{background}</div>
            </div>
        );
    }

    const mode: ResolvedMode = resolveMode(layoutMode, specs.length);

    // Order panels for focus-stack: focused (or first) spec is the main
    // panel; the rest fill the side stack in natural order.
    let ordered = specs;
    if (mode === 'focus-stack') {
        const mainSpec = specs.find((s) => s.id === focusId) ?? specs[0];
        ordered = [mainSpec, ...specs.filter((s) => s.id !== mainSpec.id)];
    }

    const showAddTile = mode === '2x2' && ordered.length < 4;

    return (
        <ResizableGrid
            mode={mode}
            ordered={ordered}
            workspacesById={workspacesById}
            activeWorkspaceId={activeWorkspaceId ?? null}
            focusId={focusId}
            maximizedId={maximizedId}
            onClose={onClose}
            onFocus={onFocus}
            onToggleMaximize={onToggleMaximize}
            onDisable={onDisable}
            onAddTerminal={onAddTerminal}
            onMarkActive={onMarkActive}
            onMarkInactive={onMarkInactive}
            showAddTile={showAddTile}
            addDisabled={addDisabled}
            addDisabledReason={addDisabledReason}
            background={background}
        />
    );
}

interface ResizableGridProps {
    mode: ResolvedMode;
    ordered: TerminalSpec[];
    workspacesById: Map<string, WorkspaceRow>;
    activeWorkspaceId: string | null;
    focusId: string | null;
    maximizedId: string | null;
    onClose: (id: string) => void;
    onFocus: (id: string) => void;
    onToggleMaximize: (id: string) => void;
    onDisable?: (id: string) => void;
    onAddTerminal: () => void;
    onMarkActive: (id: string) => void;
    onMarkInactive: (id: string) => void;
    showAddTile: boolean;
    addDisabled?: boolean;
    addDisabledReason?: string;
    background: React.ReactNode;
}

/** Column/row track counts for a mode + panel count. */
function dims(mode: ResolvedMode, count: number): { cols: number; rows: number } {
    switch (mode) {
        case 'g1':
            return { cols: 1, rows: 1 };
        case 'g2x1':
            return { cols: 2, rows: 1 };
        case 'columns':
            return { cols: 3, rows: 1 };
        case '2x2':
            return { cols: 2, rows: 2 };
        case 'focus-stack':
            // Column 1 = main, column 2 = the vertical stack of (count-1).
            return { cols: 2, rows: Math.max(1, count - 1) };
    }
}

/**
 * A unique-per-arrangement signature so a workspace remembers sizes for
 * each distinct layout it has been arranged into (2-up vs 4-up keep their
 * own tracks). Mode + counts fully describe the gutter topology.
 */
function signature(mode: ResolvedMode, count: number): string {
    const d = dims(mode, count);
    return `${mode}:${count}:${d.cols}x${d.rows}`;
}

function evenTracks(n: number): number[] {
    return Array.from({ length: n }, () => 1);
}

const ResizableGrid = ({
    mode,
    ordered,
    workspacesById,
    activeWorkspaceId,
    focusId,
    maximizedId,
    onClose,
    onFocus,
    onToggleMaximize,
    onDisable,
    onAddTerminal,
    onMarkActive,
    onMarkInactive,
    showAddTile,
    addDisabled,
    addDisabledReason,
    background,
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

    return (
        <div className="grid-wrap">
            <div ref={wrapRef} className="pgrid resizable" style={gridStyle}>
                {ordered.map((spec, i) => {
                    const isMax = maximizedId === spec.id;
                    const otherMaxed = maximized && !isMax;
                    const style: CSSProperties = otherMaxed
                        ? { display: 'none' }
                        : isMax
                          ? { gridArea: '1 / 1 / -1 / -1' }
                          : cellArea(mode, i, count);
                    const isMainInStack = mode === 'focus-stack' && i === 0;
                    return (
                        <PanelFor
                            key={spec.id}
                            spec={spec}
                            workspacesById={workspacesById}
                            focused={focusId === spec.id}
                            maximized={isMax}
                            style={style}
                            onClose={() => onClose(spec.id)}
                            onMaximize={() => onToggleMaximize(spec.id)}
                            onMinimize={
                                isMainInStack ? () => onFocus(spec.id) : undefined
                            }
                            onDisable={onDisable ? () => onDisable(spec.id) : undefined}
                            onMarkActive={() => onMarkActive(spec.id)}
                            onMarkInactive={() => onMarkInactive(spec.id)}
                        />
                    );
                })}
                {background}
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
                        <span className="at">Add a terminal</span>
                        <span className="as">from any project — pick on the left</span>
                    </button>
                )}
                {!maximized && (
                    <Gutters
                        mode={mode}
                        cols={cols}
                        rows={rows}
                        onStart={startDrag}
                        onReset={resetAxis}
                    />
                )}
            </div>
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

function resolveMode(mode: LayoutMode, count: number): ResolvedMode {
    if (mode === 'focus-stack') return 'focus-stack';
    if (mode === '2x2') return '2x2';
    if (mode === 'columns') return 'columns';
    // auto
    if (count <= 1) return 'g1';
    if (count === 2) return 'g2x1';
    if (count === 3) return 'focus-stack';
    return '2x2';
}

function cellArea(mode: ResolvedMode, index: number, count: number): CSSProperties {
    if (mode === 'focus-stack') {
        const stackRows = Math.max(1, count - 1);
        if (index === 0) {
            // main panel spans the entire column 1
            return { gridColumn: '1', gridRow: `1 / span ${stackRows}` };
        }
        return { gridColumn: '2', gridRow: `${index} / span 1` };
    }
    if (mode === '2x2') {
        // Cells fill in row-major order; index 0..3 maps to (row, col).
        const row = Math.floor(index / 2) + 1;
        const col = (index % 2) + 1;
        return { gridColumn: String(col), gridRow: String(row) };
    }
    if (mode === 'g2x1') {
        return { gridColumn: String(index + 1), gridRow: '1' };
    }
    if (mode === 'columns') {
        return { gridColumn: String(index + 1), gridRow: '1' };
    }
    // g1
    return { gridColumn: '1', gridRow: '1' };
}
