import type { TerminalTab } from './workspace-view.js';

/**
 * PANEL LAYOUT MODES (§6.5) — pure. Four modes: single, columns, rows, grid. The visible panes are the
 * strip's terminals in strip order, the active one always among them, capped by the mode (1, 2, 2, 4).
 * The mode is remembered PER WORKSPACE through the workspace-scoped `panel_layout` setting; the grid
 * template is for the count actually shown, never for empty cells. Split sizes are not remembered yet.
 */

export const LAYOUT_MODES = ['single', 'columns', 'rows', 'grid'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

const CAP: Record<LayoutMode, number> = { single: 1, columns: 2, rows: 2, grid: 4 };

export function layoutModeFrom(values: Readonly<Record<string, unknown>>): LayoutMode {
    const v = values.panel_layout;
    return (LAYOUT_MODES as readonly string[]).includes(String(v)) ? (v as LayoutMode) : 'single';
}

/** Strip order, the active one always included, at most the mode's cap. */
export function visiblePanes(state: { terminals: readonly TerminalTab[]; active: string | null }, mode: LayoutMode): string[] {
    const cap = CAP[mode];
    const ids = state.terminals.map((t) => t.id);
    if (ids.length === 0) return [];
    const active = state.active !== null && ids.includes(state.active) ? state.active : null;
    const shown = ids.slice(0, cap);
    if (active !== null && !shown.includes(active)) {
        shown.pop();
        shown.push(active);
    }
    return shown;
}

const one = 'minmax(0, 1fr)';
const n = (count: number) => (count <= 1 ? one : `repeat(${count}, ${one})`);

export function gridTemplate(mode: LayoutMode, count: number): { columns: string; rows: string } {
    const shown = Math.max(1, Math.min(count, CAP[mode]));
    switch (mode) {
        case 'single': return { columns: one, rows: one };
        case 'columns': return { columns: n(shown), rows: one };
        case 'rows': return { columns: one, rows: n(shown) };
        case 'grid': return shown <= 2 ? { columns: n(shown), rows: one } : { columns: n(2), rows: n(2) };
    }
}
