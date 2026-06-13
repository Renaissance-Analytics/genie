import type { CSSProperties } from 'react';
import TerminalPanel from './TerminalPanel';
import { IconPlus } from './icons';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';

export type LayoutMode = 'auto' | 'focus-stack' | '2x2' | 'columns';

interface Props {
    specs: TerminalSpec[];
    workspacesById: Map<string, WorkspaceRow>;
    focusId: string | null;
    maximizedId: string | null;
    onClose: (id: string) => void;
    onFocus: (id: string) => void;
    onToggleMaximize: (id: string) => void;
    onAddTerminal: () => void;
    onMarkActive: (id: string) => void;
    onMarkInactive: (id: string) => void;
    layoutMode: LayoutMode;
}

type ResolvedMode = 'g1' | 'g2x1' | 'focus-stack' | '2x2' | 'columns';

/**
 * Layout grid for selected terminal specs.
 *
 * Critical invariant: every TerminalPanel sits as a direct child of the
 * single `.pgrid` container in every mode. Layout changes (g2x1 ↔
 * focus-stack ↔ 2x2 ↔ columns) only mutate the parent's grid template +
 * each child's `gridArea` style. React reconciliation keeps each panel
 * mounted by key (= spec.id), which means xterm.js stays alive and the
 * underlying pty isn't killed and re-spawned on every layout switch.
 *
 * Maximize works the same way: maximised panel gets a full-area
 * `gridArea` and every other panel gets `display: none`. xterm refits
 * via its ResizeObserver when visibility flips.
 */
export default function TerminalGrid({
    specs,
    workspacesById,
    focusId,
    maximizedId,
    onClose,
    onFocus,
    onToggleMaximize,
    onAddTerminal,
    onMarkActive,
    onMarkInactive,
    layoutMode,
}: Props) {
    if (specs.length === 0) {
        return (
            <div className="grid-wrap">
                <button type="button" className="addtile" onClick={onAddTerminal}>
                    <span className="ai">
                        <IconPlus size={18} />
                    </span>
                    <span className="at">Add a terminal</span>
                    <span className="as">
                        from any project — pick from the tree on the left
                    </span>
                </button>
            </div>
        );
    }

    const mode: ResolvedMode = resolveMode(layoutMode, specs.length);

    // Order panels for focus-stack: the focused (or first) spec sits at
    // index 0, becoming the main panel; the rest fill the side stack in
    // their natural order. For every other mode, natural order wins.
    let ordered = specs;
    if (mode === 'focus-stack') {
        const mainSpec = specs.find((s) => s.id === focusId) ?? specs[0];
        ordered = [mainSpec, ...specs.filter((s) => s.id !== mainSpec.id)];
    }

    const gridStyle = templateFor(mode, ordered.length);
    const showAddTile = mode === '2x2' && ordered.length < 4;

    return (
        <div className="grid-wrap">
            <div className="pgrid" style={gridStyle}>
                {ordered.map((spec, i) => {
                    const isMax = maximizedId === spec.id;
                    const otherMaxed = maximizedId !== null && !isMax;
                    const style: CSSProperties = otherMaxed
                        ? { display: 'none' }
                        : isMax
                          ? { gridArea: '1 / 1 / -1 / -1' }
                          : cellArea(mode, i, ordered.length);
                    const isMainInStack = mode === 'focus-stack' && i === 0;
                    return (
                        <TerminalPanel
                            key={spec.id}
                            spec={spec}
                            workspace={
                                spec.workspace_id
                                    ? workspacesById.get(spec.workspace_id)
                                    : undefined
                            }
                            focused={focusId === spec.id}
                            maximized={isMax}
                            style={style}
                            onClose={() => onClose(spec.id)}
                            onMaximize={() => onToggleMaximize(spec.id)}
                            onMinimize={
                                isMainInStack ? () => onFocus(spec.id) : undefined
                            }
                            onMarkActive={() => onMarkActive(spec.id)}
                            onMarkInactive={() => onMarkInactive(spec.id)}
                        />
                    );
                })}
                {showAddTile && !maximizedId && (
                    <button
                        type="button"
                        className="addtile"
                        onClick={onAddTerminal}
                        style={cellArea('2x2', ordered.length, 4)}
                    >
                        <span className="ai">
                            <IconPlus size={18} />
                        </span>
                        <span className="at">Add a terminal</span>
                        <span className="as">
                            from any project — pick on the left
                        </span>
                    </button>
                )}
            </div>
        </div>
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

function templateFor(mode: ResolvedMode, count: number): CSSProperties {
    switch (mode) {
        case 'g1':
            return {
                display: 'grid',
                gridTemplateColumns: '1fr',
                gridTemplateRows: '1fr',
                gap: '1px',
            };
        case 'g2x1':
            return {
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gridTemplateRows: '1fr',
                gap: '1px',
            };
        case '2x2':
            return {
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gridTemplateRows: '1fr 1fr',
                gap: '1px',
            };
        case 'columns':
            return {
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gridTemplateRows: '1fr',
                gap: '1px',
            };
        case 'focus-stack': {
            const stackRows = Math.max(1, count - 1);
            return {
                display: 'grid',
                gridTemplateColumns: '1.62fr 1fr',
                gridTemplateRows: `repeat(${stackRows}, 1fr)`,
                gap: '1px',
            };
        }
    }
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
    // For g1, g2x1, columns: auto placement is fine.
    return {};
}
