import { describe, expect, it } from 'vitest';
import { parseTabs, serializeTabs, type TabsState } from '../src/core/workspace-tabs.js';
import { withElements, type ElementSources } from '../src/core/workspace-elements.js';
import { scanForMachineState } from '../src/core/workspace-save-guard.js';
import type { LiveModel } from '../src/core/workspace-save.js';
import { TABS_SCHEMA_URL, tabsDeclaration, tabsRestore, tabsRestorePlan } from '../src/core/workspace-tabs-save.js';

/**
 * THE WORKSPACE'S TABS, SAVED AS `.genie/tabs.json` (Tynn #756, PR7): the tabs a person designed, their grids and panels, how
 * the splits sit and how the terminals are laid out. What is a live thing on this machine is not saved: a `terminal` panel
 * is a terminal id (saved as an empty cell), and a `files` panel's folder is relative to the workspace or not saved. A clone
 * restores what it can: a `site` panel whose site is not there yet is an empty cell, said. Nothing a clone already has is
 * overwritten. Fixtures are invented names.
 */

const ROOT = 'C:/_Projects/acme';
const tab = (over: Record<string, unknown> = {}) => ({ id: 'tab-1', name: 'Work', layout: 'columns-2', cells: [{ kind: 'files', ref: 'repos/app' }, { kind: 'site', ref: 'shop.gen' }], ...over });
const raw = (...tabs: unknown[]) => JSON.stringify({ tabs });
const input = (over: Partial<{ tabs: string; panelSplits: string; panelLayout: string }> = {}) => ({ tabs: raw(tab()), panelSplits: '', panelLayout: '', ...over });
const value = (out: ReturnType<typeof tabsDeclaration>) => out.files[0]?.value as { $schema: string; tabs: { id: string; cells: unknown[] }[]; panelSplits?: Record<string, number[]>; panelLayout?: string };

describe('the file the tabs are saved as', () => {
    it('is .genie/tabs.json with the schema stamp, each tab with its id, name, layout and cells', () => {
        const out = tabsDeclaration(input(), ROOT);
        expect(out.files.map((f) => f.path)).toEqual(['.genie/tabs.json']);
        expect(value(out)).toEqual({ $schema: TABS_SCHEMA_URL, tabs: [tab()] });
        expect(TABS_SCHEMA_URL).toBe('https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/tabs.schema.json');
    });

    it('a terminal panel is a live session: saved as an empty cell, and said; its id is not in the file', () => {
        const out = tabsDeclaration(input({ tabs: raw(tab({ cells: [{ kind: 'terminal', ref: 'term_9f2' }, { kind: 'site', ref: 'shop.gen' }] })) }), ROOT);
        expect(value(out).tabs[0]!.cells).toEqual([null, { kind: 'site', ref: 'shop.gen' }]);
        expect(JSON.stringify(out.files)).not.toContain('term_9f2');
        expect(out.excluded).toEqual([{ field: '.genie/tabs.json#tab-1/cell-1', reason: expect.stringContaining('terminal') }]);
    });

    it('a files panel’s folder is saved relative to the workspace; one outside it, or climbing out, is an empty cell, and said', () => {
        const cells = [{ kind: 'files', ref: 'C:/_Projects/acme/repos/app' }, { kind: 'files', ref: 'D:/other' }, { kind: 'files', ref: '../../x' }, { kind: 'files', ref: '/data' }];
        const out = tabsDeclaration(input({ tabs: raw(tab({ layout: 'grid-2x2', cells })) }), ROOT);
        expect(value(out).tabs[0]!.cells).toEqual([{ kind: 'files', ref: 'repos/app' }, null, null, null]);
        expect(out.excluded.map((e) => e.field)).toEqual(['.genie/tabs.json#tab-1/cell-2', '.genie/tabs.json#tab-1/cell-3', '.genie/tabs.json#tab-1/cell-4']);
    });

    it('the splits and the terminal layout ride along: the splits as lists the schema allows, the grid’s as grid.columns and grid.rows', () => {
        const splits = JSON.stringify({ columns: [0.4, 0.6], rows: [0.5, 0.5], grid: { columns: [0.7, 0.3], rows: [0.2, 0.8] } });
        const out = tabsDeclaration(input({ panelSplits: splits, panelLayout: 'grid' }), ROOT);
        expect(value(out).panelSplits).toEqual({ columns: [0.4, 0.6], rows: [0.5, 0.5], 'grid.columns': [0.7, 0.3], 'grid.rows': [0.2, 0.8] });
        expect(value(out).panelLayout).toBe('grid');
    });

    it('a terminal layout alone, with no designed tab, is still a file', () => {
        const out = tabsDeclaration(input({ tabs: '{"tabs":[]}', panelLayout: 'columns' }), ROOT);
        expect(value(out)).toEqual({ $schema: TABS_SCHEMA_URL, tabs: [], panelLayout: 'columns' });
    });

    it('CONTROL: nothing designed and nothing remembered is no file, and so is a value that is not JSON', () => {
        expect(tabsDeclaration(input({ tabs: '{"tabs":[]}' }), ROOT).files).toEqual([]);
        expect(tabsDeclaration(input({ tabs: 'not json' }), ROOT).files).toEqual([]);
        expect(tabsDeclaration({ tabs: '', panelSplits: '', panelLayout: '' }, ROOT).files).toEqual([]);
    });

    it('the guard finds nothing in a saved file, and finds the terminal id in the raw setting (the control)', () => {
        const live = raw(tab({ cells: [{ kind: 'terminal', ref: 'term_9f2' }, { kind: 'files', ref: 'repos/app' }] }));
        const out = tabsDeclaration(input({ tabs: live }), ROOT);
        expect(out.files).toHaveLength(1);
        expect(scanForMachineState(out.files.map((f) => f.value))).toEqual([]);
        expect(live).toContain('term_9f2');
    });
});

describe('a clone reads the file', () => {
    const ctx = { workspacePath: '/c/acme', siteHosts: ['shop.gen'] };
    const saved = () => value(tabsDeclaration(input({ panelSplits: JSON.stringify({ columns: [0.4, 0.6], grid: { columns: [0.7, 0.3], rows: [0.2, 0.8] } }), panelLayout: 'grid' }), ROOT));

    it('into the three settings it came from: the tabs, the splits, the layout', () => {
        const r = tabsRestore(saved(), ctx);
        expect(r.state).toEqual({ tabs: [tab()] });
        expect(JSON.parse(r.panelSplits!)).toEqual({ columns: [0.4, 0.6], grid: { columns: [0.7, 0.3], rows: [0.2, 0.8] } });
        expect(r.panelLayout).toBe('grid');
        expect(r.notes).toEqual([]);
    });

    it('a save followed by a restore gives back the same tabs, minus the terminals', () => {
        const live = parseTabs(raw(tab({ cells: [{ kind: 'terminal', ref: 'term_1' }, { kind: 'files', ref: 'repos/app' }] })));
        const saves = value(tabsDeclaration({ tabs: serializeTabs(live), panelSplits: '', panelLayout: '' }, ROOT));
        expect(tabsRestore(saves, ctx).state.tabs[0]!.cells).toEqual([null, { kind: 'files', ref: 'repos/app' }]);
    });

    it('a hand-edited file cannot bring a terminal, a folder outside the workspace or a site that is not here: each is an empty cell, said', () => {
        const edited = { tabs: [tab({ layout: 'grid-2x2', cells: [{ kind: 'terminal', ref: 'term_x' }, { kind: 'files', ref: '../../x' }, { kind: 'site', ref: 'ghost.gen' }, { kind: 'files', ref: 'repos/app' }] })] };
        const r = tabsRestore(edited, ctx);
        expect(r.state.tabs[0]!.cells).toEqual([null, null, null, { kind: 'files', ref: 'repos/app' }]);
        expect(r.notes).toHaveLength(3);
        expect(r.notes.join(' ')).toMatch(/terminal/);
        expect(r.notes.join(' ')).toMatch(/ghost\.gen/);
    });

    it('a layout nobody has drops its tab, and a splits value that does not fit is not used; both said', () => {
        const r = tabsRestore({ tabs: [tab({ layout: 'hexagon' }), tab({ id: 'tab-2' })], panelSplits: { columns: [0.9, 0.9, 0.9] }, panelLayout: 'sideways' }, ctx);
        expect(r.state.tabs.map((t) => t.id)).toEqual(['tab-2']);
        expect(r.panelSplits).toBeNull();
        expect(r.panelLayout).toBeNull();
        expect(r.notes.length).toBeGreaterThanOrEqual(3);
    });

    it('CONTROL: nothing, or something that is not a tabs file, restores nothing', () => {
        for (const bad of [null, 'x', 7, [], {}]) {
            const r = tabsRestore(bad, ctx);
            expect(r.state).toEqual({ tabs: [] });
            expect(r.panelSplits).toBeNull();
            expect(r.panelLayout).toBeNull();
        }
    });
});

describe('what a clone already has is never overwritten', () => {
    const mine: TabsState = { tabs: [{ id: 'tab-1', name: 'Work', layout: 'single', cells: [null] }, { id: 'tab-2', name: 'Mine', layout: 'single', cells: [null] }] };

    it('a tab the clone lacks is added; one it has the same is present; one that differs is reported and left as it is', () => {
        const file: TabsState = { tabs: [{ id: 'tab-1', name: 'Work', layout: 'single', cells: [null] }, { id: 'tab-2', name: 'Theirs', layout: 'single', cells: [null] }, { id: 'tab-3', name: 'New', layout: 'single', cells: [null] }] };
        const plan = tabsRestorePlan(file, mine);
        expect(plan.add.map((t) => t.id)).toEqual(['tab-3']);
        expect(plan.present).toEqual(['tab-1']);
        expect(plan.differs).toEqual(['tab-2']);
        expect(plan.state.tabs.map((t) => [t.id, t.name])).toEqual([['tab-1', 'Work'], ['tab-2', 'Mine'], ['tab-3', 'New']]);
    });

    it('CONTROL: an empty file changes nothing', () => {
        const plan = tabsRestorePlan({ tabs: [] }, mine);
        expect(plan.add).toEqual([]);
        expect(plan.state).toEqual(mine);
    });
});

describe('the tabs in Save to repo', () => {
    const model = (): LiveModel => ({ manifest: { name: 'Acme' }, manifestText: '{"name":"Acme"}\n', files: [{ path: '.flows/a.json', value: { v: 1 } }, { path: '.genie/tabs.json', value: { stale: true } }] });
    const sources = (overrides: Record<string, string>): ElementSources => ({ services: [], workspace: { overrides, defaultAgent: null, envFile: null, mcpOff: [] }, agents: [] });

    it('are the workspace’s own settings read as they are kept; the file replaces any already in the model, and the others stay', () => {
        const out = withElements(model(), sources({ workspace_tabs: raw(tab()), panel_layout: 'rows' }), 'ws_acme', ROOT);
        expect(out.model.files.map((f) => f.path)).toEqual(['.flows/a.json', '.genie/tabs.json']);
        expect((out.model.files[1]!.value as { tabs: unknown[]; panelLayout: string }).panelLayout).toBe('rows');
        expect((out.model.files[1]!.value as { stale?: boolean }).stale).toBeUndefined();
    });

    it('what was left out of the tabs is told with the rest', () => {
        const out = withElements(model(), sources({ workspace_tabs: raw(tab({ cells: [{ kind: 'terminal', ref: 'term_1' }, null] })) }), 'ws_acme', ROOT);
        expect(out.excluded.map((e) => e.field)).toEqual(['.genie/tabs.json#tab-1/cell-1']);
    });

    it('CONTROL: settings with no tabs leave the files as they were', () => {
        const out = withElements(model(), sources({ agent_cap: '4' }), 'ws_acme', ROOT);
        expect(out.model.files.map((f) => f.path)).toEqual(['.flows/a.json', '.genie/tabs.json']);
        expect((out.model.files[1]!.value as { stale?: boolean }).stale).toBe(true);
    });
});
