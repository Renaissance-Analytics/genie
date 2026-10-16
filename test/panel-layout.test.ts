import { describe, expect, it } from 'vitest';
import { LAYOUT_MODES, gridTemplate, layoutModeFrom, visiblePanes } from '../src/core/panel-layout.js';
import { SETTINGS } from '../src/core/settings.js';
import type { TerminalTab } from '../src/core/workspace-view.js';

/**
 * PANEL LAYOUT MODES (§6.5) — pure. Four modes: single, columns, rows, grid. The visible panes are the
 * strip's terminals in strip order, the active one always among them, capped by the mode (1, 2, 2, 4);
 * hidden terminals are never shown. The mode is remembered PER WORKSPACE through the workspace-scoped
 * `panel_layout` setting. Split sizes are not remembered yet — said in the gap table, not here.
 */

const tab = (id: string): TerminalTab => ({ id, workspaceId: 'tynn', shell: 'sh', pid: 1, exited: null });
const terminals = [tab('t1'), tab('t2'), tab('t3'), tab('t4'), tab('t5')];

describe('visiblePanes', () => {
    it('single shows the active one; columns and rows two; grid four — strip order, active always included, nothing hidden', () => {
        expect(visiblePanes({ terminals, active: 't3' }, 'single')).toEqual(['t3']);
        expect(visiblePanes({ terminals, active: 't1' }, 'columns')).toEqual(['t1', 't2']);
        expect(visiblePanes({ terminals, active: 't3' }, 'rows')).toEqual(['t1', 't3']);
        expect(visiblePanes({ terminals, active: 't5' }, 'grid')).toEqual(['t1', 't2', 't3', 't5']);
        expect(visiblePanes({ terminals: terminals.slice(0, 2), active: 't2' }, 'grid')).toEqual(['t1', 't2']);
        expect(visiblePanes({ terminals: [], active: null }, 'grid')).toEqual([]);
        expect(visiblePanes({ terminals, active: null }, 'columns')).toEqual(['t1', 't2']);
    });
});

describe('gridTemplate', () => {
    it('is the CSS for the count actually shown — never empty cells', () => {
        expect(gridTemplate('single', 1)).toEqual({ columns: 'minmax(0, 1fr)', rows: 'minmax(0, 1fr)' });
        expect(gridTemplate('columns', 2)).toEqual({ columns: 'repeat(2, minmax(0, 1fr))', rows: 'minmax(0, 1fr)' });
        expect(gridTemplate('rows', 2)).toEqual({ columns: 'minmax(0, 1fr)', rows: 'repeat(2, minmax(0, 1fr))' });
        expect(gridTemplate('grid', 4)).toEqual({ columns: 'repeat(2, minmax(0, 1fr))', rows: 'repeat(2, minmax(0, 1fr))' });
        expect(gridTemplate('grid', 3)).toEqual({ columns: 'repeat(2, minmax(0, 1fr))', rows: 'repeat(2, minmax(0, 1fr))' });
        expect(gridTemplate('grid', 2)).toEqual({ columns: 'repeat(2, minmax(0, 1fr))', rows: 'minmax(0, 1fr)' });
        expect(gridTemplate('columns', 1)).toEqual({ columns: 'minmax(0, 1fr)', rows: 'minmax(0, 1fr)' });
    });
});

describe('the setting', () => {
    it('panel_layout is a workspace-scoped enum of the four modes, default single; layoutModeFrom falls back to single', () => {
        expect(LAYOUT_MODES).toEqual(['single', 'columns', 'rows', 'grid']);
        expect(SETTINGS.find((s) => s.key === 'panel_layout')).toMatchObject({ scope: 'workspace', type: 'enum', options: ['single', 'columns', 'rows', 'grid'], default: 'single' });
        expect(layoutModeFrom({ panel_layout: 'grid' })).toBe('grid');
        expect(layoutModeFrom({})).toBe('single');
        expect(layoutModeFrom({ panel_layout: 'mosaic' })).toBe('single');
    });
});
