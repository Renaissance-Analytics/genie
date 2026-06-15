/**
 * Pure layout helpers for the terminal grid. Kept free of React/DOM so the
 * unified "one keyed panel list spanning active + background" computation can
 * be unit-tested under the Node test environment (mirrors how the keyboard
 * intent resolver was extracted into `master-shortcuts.ts`).
 *
 * THE REMOUNT BUG THIS GUARDS AGAINST
 * -----------------------------------
 * The keep-alive design renders off-workspace selected panels mounted-hidden
 * so their PTYs survive a workspace switch. The grid previously emitted the
 * active-workspace panels and the off-workspace panels as TWO separate array
 * expressions in the same parent (`{ordered.map(...)}` then `{background}`).
 * React only matches `key`s WITHIN the same array child-slot, so a panel that
 * crossed from one slot to the other on a workspace switch got a different
 * effective key (`.0:<id>` vs `.1:<id>`) → React unmounted the old instance and
 * mounted a fresh one → XTerm remounted → PTY reset.
 *
 * THE FIX
 * -------
 * Build ONE merged, stably-ordered list of every selected spec (active +
 * background). Each entry carries the STYLE that decides its role: active
 * visible panels get their grid placement; everything else (off-workspace, or
 * hidden because another panel is maximized) gets `display: none`. The caller
 * renders this single list with a single `.map()` keyed by `spec.id` inside one
 * stable container, so no panel ever crosses array slots or subtrees on a
 * switch — React preserves every instance and only updates props.
 */
import type { CSSProperties } from 'react';
import type { TerminalSpec } from './genie';

export type ResolvedMode = 'g1' | 'g2x1' | 'focus-stack' | '2x2' | 'columns';
export type LayoutMode = 'auto' | 'focus-stack' | '2x2' | 'columns';

/** One panel in the unified list: its spec plus the style that sets its role. */
export interface PanelEntry {
    spec: TerminalSpec;
    /** Grid placement when active+visible; `{ display: 'none' }` otherwise. */
    style: CSSProperties;
    /** True when this entry is the active workspace's focus-stack main panel. */
    isMainInStack: boolean;
    /** True when this entry is the maximized panel. */
    isMaximized: boolean;
    /** True when active+visible (drives focus prop + per-panel index). */
    visible: boolean;
}

export function resolveMode(mode: LayoutMode, count: number): ResolvedMode {
    if (mode === 'focus-stack') return 'focus-stack';
    if (mode === '2x2') return '2x2';
    if (mode === 'columns') return 'columns';
    // auto
    if (count <= 1) return 'g1';
    if (count === 2) return 'g2x1';
    if (count === 3) return 'focus-stack';
    return '2x2';
}

/** Column/row track counts for a mode + panel count. */
export function dims(
    mode: ResolvedMode,
    count: number,
): { cols: number; rows: number } {
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
 * A unique-per-arrangement signature so a workspace remembers sizes for each
 * distinct layout it has been arranged into (2-up vs 4-up keep their own
 * tracks). Mode + counts fully describe the gutter topology.
 */
export function signature(mode: ResolvedMode, count: number): string {
    const d = dims(mode, count);
    return `${mode}:${count}:${d.cols}x${d.rows}`;
}

export function cellArea(
    mode: ResolvedMode,
    index: number,
    count: number,
): CSSProperties {
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

/**
 * Reorder the active workspace's specs for focus-stack: the focused (or first)
 * spec becomes the main panel; the rest fill the side stack in natural order.
 * For all other modes the order is unchanged.
 */
export function orderForMode(
    mode: ResolvedMode,
    specs: TerminalSpec[],
    focusId: string | null,
): TerminalSpec[] {
    if (mode !== 'focus-stack') return specs;
    if (specs.length === 0) return specs;
    const mainSpec = specs.find((s) => s.id === focusId) ?? specs[0];
    return [mainSpec, ...specs.filter((s) => s.id !== mainSpec.id)];
}

export interface BuildPanelListArgs {
    /** Active-workspace visible specs, ALREADY ordered for the resolved mode. */
    ordered: TerminalSpec[];
    /** Off-workspace selected specs (kept mounted-hidden). */
    background: TerminalSpec[];
    mode: ResolvedMode;
    maximizedId: string | null;
}

const HIDDEN: CSSProperties = { display: 'none' };

/**
 * Build the UNIFIED panel list: every selected spec — active workspace's AND
 * every other workspace's — appears exactly once, in a STABLE order, each
 * carrying the style that sets its role.
 *
 * Order contract (stable across workspace switches so React preserves every
 * instance): active visible specs first (in their layout order), then all
 * background specs sorted by id (ULIDs are creation-ordered). The KEY of each
 * entry is `spec.id`; because the whole list lives in one `.map()` in one
 * container, an entry never changes array-slot when a panel crosses between
 * active and background on a switch — React reconciles it as the SAME instance
 * and only updates the `style` prop. That is exactly what keeps XTerm mounted
 * and the PTY alive.
 *
 * Styling:
 *   - active + visible, nothing maximized → grid placement via `cellArea`.
 *   - active + visible, this one maximized → full-bleed gridArea.
 *   - active + visible, ANOTHER maximized → `display: none`.
 *   - background (off-workspace)          → `display: none`.
 */
export function buildPanelList({
    ordered,
    background,
    mode,
    maximizedId,
}: BuildPanelListArgs): PanelEntry[] {
    const count = ordered.length;
    const maximized = maximizedId !== null;

    const activeEntries: PanelEntry[] = ordered.map((spec, i) => {
        const isMax = maximizedId === spec.id;
        const otherMaxed = maximized && !isMax;
        const style: CSSProperties = otherMaxed
            ? HIDDEN
            : isMax
              ? { gridArea: '1 / 1 / -1 / -1' }
              : cellArea(mode, i, count);
        return {
            spec,
            style,
            isMainInStack: mode === 'focus-stack' && i === 0,
            isMaximized: isMax,
            // A panel hidden by another being maximized is not "visible" for
            // focus purposes, but it is still an active-workspace panel.
            visible: !otherMaxed,
        };
    });

    // Background specs in a STABLE order (by id). Never visible.
    const bgEntries: PanelEntry[] = [...background]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((spec) => ({
            spec,
            style: HIDDEN,
            isMainInStack: false,
            isMaximized: false,
            visible: false,
        }));

    return [...activeEntries, ...bgEntries];
}
