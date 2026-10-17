import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from '../src/core/route.js';
import { LAYOUTS, PANEL_KINDS } from '../src/core/workspace-tabs.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * WORKSPACE TABS YOU DESIGN — the view (Tynn story #282, row 2). The owner, 2026-10-17: Agents, then the tabs you made,
 * then a small + (always just left of Settings), then Settings — last. A new tab opens to a panel designer: pick a grid,
 * add panels to its cells (terminal, file browser, Genie site, artboard, dashboard widget).
 */
const ws = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const tabs = JSON.stringify({ tabs: [{ id: 'tab-1', name: 'Ops', layout: 'columns-2', cells: [{ kind: 'widget', ref: 'agents' }, null] }] });
const noTerminals = { open: async () => ({ id: 't', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, close: () => true, list: async () => [], attach: async () => null, onData: () => () => {}, onExit: () => () => {} } as never;
const ops = (values: Record<string, boolean | string> | null) => ({ asleep: false, agentCount: 0, settings: { values, onSet: () => {} } } as never);
const render = (view: string, values: Record<string, boolean | string> | null = { workspace_tabs: tabs }) =>
    renderToStaticMarkup(<Workspace workspace={ws} terminals={noTerminals} ops={ops(values)} view={view as never} rows={[]} />);
const stripOf = (html: string) => [...html.matchAll(/data-workspace-tab="([^"]+)"/g)].map((m) => m[1]);

describe('the route', () => {
    it('?view=tab:<id> is a designed tab; a malformed id falls back to Agents', () => {
        expect(parseRoute('genie://workspace/tynn?view=tab:tab-1')).toMatchObject({ surface: 'workspace', view: 'tab:tab-1' });
        expect(parseRoute('genie://workspace/tynn?view=tab:../../x')).toMatchObject({ view: 'home' });
        expect(formatRoute(parseRoute('genie://workspace/tynn?view=tab:tab-1'))).toContain('view=tab%3Atab-1');
    });
});

describe('the strip', () => {
    it('Agents, your tabs, +, Settings — no fixed Terminals tab', () => {
        expect(stripOf(render('home'))).toEqual(['home', 'tab:tab-1', 'add', 'settings']);
        expect(render('home')).toMatch(/data-workspace-tab="add"[^>]*aria-label="New tab"/);
    });

    it('no settings to keep tabs in → no + (a control that does nothing is not offered)', () => {
        expect(stripOf(renderToStaticMarkup(<Workspace workspace={ws} terminals={noTerminals} view="home" rows={[]} />))).toEqual(['home']);
    });
});

describe('a designed tab', () => {
    it('its grid, the layout picker with the current one marked, a placed panel, and an empty cell offering every kind', () => {
        const html = render('tab:tab-1');
        expect(html).toContain('data-designed-tab="tab-1"');
        expect(html).toContain('data-layout="columns-2"');
        expect(html.match(/data-cell="/g) ?? []).toHaveLength(2);
        for (const l of LAYOUTS) expect(html).toContain(`data-layout-option="${l.id}"`);
        expect(html).toMatch(/data-layout-option="columns-2"[^>]*data-current="true"/);
        expect(html).toContain('data-panel="widget"');
        const empty = html.slice(html.indexOf('data-cell="1"'));
        for (const k of PANEL_KINDS) expect(empty).toContain(`data-add-panel="${k}"`);
    });

    it('an unknown tab id says so and offers Agents — never a blank body', () => {
        expect(render('tab:tab-9')).toContain('data-designed-tab-missing=""');
    });
});
