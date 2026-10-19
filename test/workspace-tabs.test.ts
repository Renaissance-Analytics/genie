import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import {
    LAYOUTS,
    PANEL_KINDS,
    addTab,
    clearCell,
    parseTabs,
    placePanel,
    removeTab,
    renameTab,
    serializeTabs,
    setLayout,
    tabStrip,
    type TabsState,
} from '../src/core/workspace-tabs.js';

/**
 * WORKSPACE TABS YOU DESIGN (Tynn story #282). The owner, 2026-10-17: "By default we will have the Agents and Settings
 * tab, but in between those tabs is a small tab with a plus sign. Clicking this will create a new tab (this plus tab is
 * always to the left of Settings so settings is always the last tab). New tabs open to a panel designer that lets me
 * choose my grid layout and add panels to the grid. … Panels can be any kind of content from terminals, file browser,
 * genie site, artboards, and dashboard widgets. Genie Workspaces are not just dev environments for building apps, they
 * are for building out any kind of agentic apps and workflows."
 *
 * This is the MODEL: what tabs exist, in what order, which grid each has, what sits in each cell, and how it is kept.
 */
const empty: TabsState = { tabs: [] };

describe('the strip', () => {
    it('by default: Dashboard, +, Settings — Settings always last, + always just before it', () => {
        expect(tabStrip(empty).map((t) => t.kind)).toEqual(['dashboard', 'add', 'settings']);
    });

    it('designed tabs sit between Dashboard and +, in the order made', () => {
        const a = addTab(empty, 'Ops').state;
        const b = addTab(a, 'Board').state;
        expect(tabStrip(b).map((t) => (t.kind === 'designed' ? t.name : t.kind))).toEqual(['dashboard', 'Ops', 'Board', 'add', 'settings']);
    });
});

describe('tabs', () => {
    it('a new tab: a fresh id, the name given (or "Tab N"), the single layout, its cell empty — opens to the designer', () => {
        const { state, id } = addTab(empty);
        expect(state.tabs).toEqual([{ id, name: 'Tab 1', layout: 'single', cells: [null] }]);
        const second = addTab(state);
        expect(second.state.tabs[1]!.name).toBe('Tab 2');
        expect(second.id).not.toBe(id);
    });

    it('rename (blank refused), remove; an unknown id changes nothing', () => {
        const { state, id } = addTab(empty, 'Ops');
        expect(renameTab(state, id, 'Operations').tabs[0]!.name).toBe('Operations');
        expect(renameTab(state, id, '   ').tabs[0]!.name).toBe('Ops');
        expect(removeTab(state, id).tabs).toEqual([]);
        expect(removeTab(state, 'nope')).toBe(state);
    });
});

describe('layouts and panels', () => {
    it('the grids on offer, each with its cell count', () => {
        expect(LAYOUTS.map((l) => [l.id, l.cells])).toEqual([
            ['single', 1], ['columns-2', 2], ['columns-3', 3], ['rows-2', 2], ['grid-2x2', 4], ['main-side', 2], ['main-stack', 3],
        ]);
    });

    it('the panel kinds: terminal, file browser, Genie site, artboard, dashboard widget', () => {
        expect(PANEL_KINDS).toEqual(['terminal', 'files', 'site', 'artboard', 'widget']);
    });

    it('a panel goes into a cell; a cell clears; a cell out of range or an unknown kind is refused', () => {
        const { state, id } = addTab(empty);
        const two = setLayout(state, id, 'columns-2').state;
        const placed = placePanel(two, id, 1, { kind: 'files', ref: 'repos/genie' });
        expect(placed.tabs[0]!.cells).toEqual([null, { kind: 'files', ref: 'repos/genie' }]);
        expect(clearCell(placed, id, 1).tabs[0]!.cells).toEqual([null, null]);
        expect(placePanel(two, id, 5, { kind: 'files', ref: null })).toBe(two);
        expect(placePanel(two, id, 0, { kind: 'nope' as never, ref: null })).toBe(two);
    });

    it('a smaller grid keeps the panels in order and HANDS BACK the ones that no longer fit — nothing lost silently', () => {
        const { state, id } = addTab(empty);
        let s = setLayout(state, id, 'grid-2x2').state;
        s = placePanel(s, id, 0, { kind: 'terminal', ref: 't1' });
        s = placePanel(s, id, 3, { kind: 'site', ref: 'moic.gen' });
        const smaller = setLayout(s, id, 'columns-2');
        expect(smaller.state.tabs[0]!.cells).toEqual([{ kind: 'terminal', ref: 't1' }, null]);
        expect(smaller.dropped).toEqual([{ kind: 'site', ref: 'moic.gen' }]);
        const bigger = setLayout(smaller.state, id, 'columns-3');
        expect(bigger.state.tabs[0]!.cells).toEqual([{ kind: 'terminal', ref: 't1' }, null, null]);
        expect(bigger.dropped).toEqual([]);
    });
});

describe('kept per workspace', () => {
    it('serialize → parse is the same state', () => {
        const { state, id } = addTab(empty, 'Ops');
        const s = placePanel(setLayout(state, id, 'main-side').state, id, 0, { kind: 'widget', ref: 'agents' });
        expect(parseTabs(serializeTabs(s))).toEqual(s);
    });

    it('a malformed value reads as no tabs; a malformed TAB is dropped and the rest kept; a bad cell is emptied', () => {
        expect(parseTabs('not json')).toEqual(empty);
        expect(parseTabs('{"tabs": 3}')).toEqual(empty);
        const raw = JSON.stringify({ tabs: [
            { id: 'a', name: 'Good', layout: 'columns-2', cells: [{ kind: 'terminal', ref: 't1' }, { kind: 'bogus', ref: null }] },
            { id: 'b', name: '', layout: 'single', cells: [null] },
            { id: 'c', name: 'Bad layout', layout: 'hexagon', cells: [null] },
        ] });
        expect(parseTabs(raw)).toEqual({ tabs: [{ id: 'a', name: 'Good', layout: 'columns-2', cells: [{ kind: 'terminal', ref: 't1' }, null] }] });
    });

    it('stored as a per-workspace setting; agents may design only when the workspace allows it (off by default)', () => {
        expect(SETTINGS.find((s) => s.key === 'workspace_tabs')).toMatchObject({ scope: 'workspace', type: 'string', default: '{"tabs":[]}' });
        expect(SETTINGS.find((s) => s.key === 'agents_design_tabs')).toMatchObject({ scope: 'workspace', type: 'boolean', default: false });
    });
});
