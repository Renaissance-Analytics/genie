import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyWorkspace, terminalExited, terminalOpened } from '../src/core/workspace-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * A TERMINAL PANEL IS ONE TERMINAL (beta.33 item 9, carried to beta.35; the owner, 2026-10-20, of a designed tab's
 * Terminals panel: "A fucking terminal panel is 1 panel for that terminal. All this extra shit is stupid and already
 * part of the Panel Design ux for custom tabs."). The panel drew the whole terminal MANAGER — SINGLE / COLUMNS / ROWS /
 * GRID, + terminal, + code, a strip of shells — inside one cell: a second layout system inside the designer's. Now the
 * panel is the ONE terminal its cell names, filling the cell; several terminals are several panels, laid out by the tab.
 * A panel with no terminal yet starts one (as Genie 1's grid did: the default shell, no picker) and keeps it; a panel
 * whose terminal has ended says so, with Start a new terminal.
 */

const ws = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const tabWith = (ref: string | null) => JSON.stringify({ tabs: [{ id: 'tab-1', name: 'Ops', layout: 'single', cells: [{ kind: 'terminal', ref }] }] });
const ops = (tabs: string) => ({ asleep: false, agentCount: 0, settings: { values: { workspace_tabs: tabs }, onSet: () => {} } } as never);
const opened = (id: string) => ({ id, workspaceId: 'tynn', shell: '/bin/bash', pid: 1, exited: null });
const twoTerminals = terminalOpened(terminalOpened(emptyWorkspace(), opened('t1'), 'one'), opened('t2'), 'two');
const render = (ref: string | null, state = twoTerminals) =>
    renderToStaticMarkup(<Workspace view={'tab:tab-1' as never} workspace={ws} terminals={NO_TERMINALS} ops={ops(tabWith(ref))} initialState={state} rows={[]} />);
const cellOf = (html: string) => html.slice(html.indexOf('data-cell="0"'));

describe('a terminal panel', () => {
    it('is the ONE terminal its cell names — no layout modes, no + terminal / + code, no strip of shells', () => {
        const cell = cellOf(render('t2'));
        expect(cell).toMatch(/data-terminal-panel="t2"/);
        expect(cell).not.toContain('data-layout-control');
        expect(cell).not.toContain('data-terminal-tabs');
        expect(cell).not.toContain('data-terminal-tab=');
        expect(cell).not.toContain('data-terminal-add');
        expect(cell).not.toContain('data-action="add-code"');
        // The other terminal of the workspace is not drawn in this panel.
        expect(cell).not.toMatch(/data-terminal-panel="t1"/);
    });

    it('with no terminal yet, it starts one — no picker', () => {
        const cell = cellOf(render(null));
        expect(cell).toMatch(/data-terminal-panel-starting=""/);
        expect(cell).not.toContain('data-layout-control');
    });

    it('a terminal that ended says so, with its code, and offers a new one', () => {
        const cell = cellOf(render('t1', terminalExited(twoTerminals, 't1', 2)));
        expect(cell).toMatch(/data-terminal-panel="t1"[^>]*data-exited="2"/);
        expect(cell).toMatch(/data-action="terminal-panel-restart"[^>]*>[\s\S]*?Start a new terminal/);
    });

    it('a terminal that is no longer there (closed elsewhere) is said, with Start a new terminal — never another terminal in its place', () => {
        const cell = cellOf(render('t9'));
        expect(cell).toMatch(/data-terminal-panel-gone="t9"/);
        expect(cell).toMatch(/data-action="terminal-panel-restart"/);
        expect(cell).not.toMatch(/data-terminal-panel="t[12]"/);
    });
});

describe('CONTROL: the workspace’s Terminals view keeps its manager', () => {
    it('layout modes and the strip of shells are still there', () => {
        const html = renderToStaticMarkup(<Workspace view="terminals" workspace={ws} terminals={NO_TERMINALS} ops={ops(tabWith(null))} initialState={twoTerminals} rows={[]} />);
        expect(html).toContain('data-layout-control');
        expect(html).toContain('data-terminal-tabs');
        expect(html).toContain('data-terminal-add');
    });
});
