import type { CodeTab, PluginTab, TerminalTab } from './workspace-view.js';

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
export function visiblePanes(state: { terminals: readonly TerminalTab[]; codes?: readonly CodeTab[] | undefined; plugins?: readonly PluginTab[] | undefined; active: string | null }, mode: LayoutMode): string[] {
    const cap = CAP[mode];
    // Strip order: the shells, then the code panes (§4.6). One list, one cap, one active.
    const ids = [...state.terminals.map((t) => t.id), ...(state.codes ?? []).map((c) => c.id), ...(state.plugins ?? []).map((p) => p.id)];
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

/**
 * SPLIT SIZES (§4.6, §6.5): the fractions of the tracks, per axis, or null for equal tracks. Remembered per
 * workspace and per arrangement in the internal `panel_splits` setting (JSON per layout mode).
 */
export interface Splits {
    readonly columns: readonly number[] | null;
    readonly rows: readonly number[] | null;
}

const NO_SPLITS: Splits = { columns: null, rows: null };
const MIN_FRACTION = 0.1;

/** Weighted tracks: `minmax(0, 60fr) minmax(0, 40fr)`; equal tracks when there are no fractions (what `n` always drew). */
const weighted = (fractions: readonly number[] | null, count: number): string =>
    fractions && fractions.length === count ? fractions.map((f) => `minmax(0, ${Math.round(f * 100)}fr)`).join(' ') : n(count);

export function gridTemplate(mode: LayoutMode, count: number, splits: Splits = NO_SPLITS): { columns: string; rows: string } {
    const shown = Math.max(1, Math.min(count, CAP[mode]));
    switch (mode) {
        case 'single': return { columns: one, rows: one };
        case 'columns': return { columns: weighted(splits.columns, shown), rows: one };
        case 'rows': return { columns: one, rows: weighted(splits.rows, shown) };
        case 'grid': return shown <= 2 ? { columns: weighted(splits.columns, shown), rows: one } : { columns: weighted(splits.columns, 2), rows: weighted(splits.rows, 2) };
    }
}

/** A stored axis is used only when it FITS: the right count, every pane at least a tenth, the sum one. Otherwise null — equal, nothing repaired. */
function fits(raw: unknown, count: number): readonly number[] | null {
    if (!Array.isArray(raw) || raw.length !== count || count < 2) return null;
    if (!raw.every((f) => typeof f === 'number' && Number.isFinite(f) && f >= MIN_FRACTION - 1e-9)) return null;
    const sum = (raw as number[]).reduce((a, b) => a + b, 0);
    return Math.abs(sum - 1) < 1e-6 ? [...(raw as number[])] : null;
}

function parseStored(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const raw = values.panel_splits;
    if (typeof raw !== 'string' || raw.length === 0) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** The remembered splits for this mode and the count actually shown; null per axis when nothing fits. */
export function splitsFrom(values: Readonly<Record<string, unknown>>, mode: LayoutMode, count: number): Splits {
    const stored = parseStored(values);
    switch (mode) {
        case 'single': return NO_SPLITS;
        case 'columns': return { columns: fits(stored.columns, count), rows: null };
        case 'rows': return { columns: null, rows: fits(stored.rows, count) };
        case 'grid': {
            const g = typeof stored.grid === 'object' && stored.grid !== null ? (stored.grid as Record<string, unknown>) : {};
            return count <= 2 ? { columns: fits(g.columns, count), rows: null } : { columns: fits(g.columns, 2), rows: fits(g.rows, 2) };
        }
    }
}

/** Move the boundary after `index` by `delta` (a fraction of the whole), keeping the sum and never squeezing a pane under a tenth. */
export function dragSplit(fractions: readonly number[], index: number, delta: number): number[] {
    if (index < 0 || index >= fractions.length - 1) return [...fractions];
    const a = fractions[index]!;
    const b = fractions[index + 1]!;
    const moved = Math.max(MIN_FRACTION, Math.min(a + b - MIN_FRACTION, a + delta));
    const out = [...fractions];
    out[index] = Number(moved.toFixed(6));
    out[index + 1] = Number((a + b - moved).toFixed(6));
    return out;
}

/** Write this mode's fractions into the stored blob, keeping the other modes; a bad blob is replaced. */
export function serializeSplits(stored: string, mode: LayoutMode, splits: Splits): string {
    const current = parseStored({ panel_splits: stored });
    const next: Record<string, unknown> = { ...current };
    if (mode === 'columns' && splits.columns) next.columns = splits.columns;
    if (mode === 'rows' && splits.rows) next.rows = splits.rows;
    if (mode === 'grid') next.grid = { ...(typeof current.grid === 'object' && current.grid !== null ? (current.grid as Record<string, unknown>) : {}), ...(splits.columns ? { columns: splits.columns } : {}), ...(splits.rows ? { rows: splits.rows } : {}) };
    return JSON.stringify(next);
}
