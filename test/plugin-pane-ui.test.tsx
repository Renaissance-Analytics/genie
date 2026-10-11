import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyWorkspace, pluginClosed, pluginOpened, terminalOpened, type TerminalTab } from '../src/core/workspace-view.js';
import { visiblePanes } from '../src/core/panel-layout.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { PluginPane } from '../src/renderer/components/PluginPane.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * PLUGIN PANES IN THE WORKSPACE GRID (§4.6 `+plugin`, §6.7). A plugin's panel is a pane kind beside the
 * shells and the code panes: it mounts the vetted Fancy component the manifest named, with the manifest's
 * props, and nothing else — there is no plugin code in the renderer to run. `+plugin` lists the enabled
 * plugins' panels; one pane per panel; closing is just closing.
 */

const tab = (id: string): TerminalTab => ({ id, workspaceId: 'tynn', shell: 'sh', pid: 1, exited: null });
const workspace = { id: 'tynn', name: 'tynn', path: '/w/tynn' };
const panels = [
    { pluginId: 'acme.lint', pluginName: 'Acme Lint', id: 'report', title: 'Lint report', fancyComponent: { export: 'ContentRenderer' as const }, props: { value: '# Lint report\n\n3 fixed' } },
    { pluginId: 'acme.lint', pluginName: 'Acme Lint', id: 'config', title: 'Lint config', fancyComponent: { export: 'JsonEditor' as const }, props: { value: { strict: true } } },
];

describe('plugin panes in the workspace state', () => {
    it('one pane per plugin panel, activated on open; closing falls back like a code pane; it counts against the layout cap', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = pluginOpened(s, 'acme.lint', 'report');
        expect(s.plugins).toEqual([{ id: 'plugin:acme.lint/report', pluginId: 'acme.lint', panelId: 'report' }]);
        expect(s.active).toBe('plugin:acme.lint/report');
        expect(pluginOpened(s, 'acme.lint', 'report').plugins).toHaveLength(1);
        expect(visiblePanes(s, 'columns')).toEqual(['t1', 'plugin:acme.lint/report']);
        s = pluginClosed(s, 'plugin:acme.lint/report');
        expect(s.plugins).toEqual([]);
        expect(s.active).toBe('t1');
    });
});

describe('PluginPane', () => {
    it('mounts the vetted component the manifest named, with its props, and names its plugin', () => {
        const html = renderToStaticMarkup(<PluginPane panel={panels[0]!} />);
        expect(html).toContain('data-plugin-pane="acme.lint/report"');
        expect(html).toContain('data-fancy-export="ContentRenderer"');
        expect(html).toMatch(/Lint report/);
        expect(html).toMatch(/3 fixed/);
        expect(html).toMatch(/Acme Lint/);
    });

    it('a panel whose export is not vetted renders a refusal, never the component', () => {
        const html = renderToStaticMarkup(<PluginPane panel={{ ...panels[0]!, fancyComponent: { export: 'Terminal' as never } }} />);
        expect(html).toContain('data-plugin-pane-refused');
        expect(html).toMatch(/not a vetted Fancy component/);
        expect(html).not.toContain('data-fancy-export');
    });
});

describe('the Workspace surface with plugin panes', () => {
    it('+plugin lists the enabled plugins’ panels when there are any; absent otherwise', () => {
        const withPanels = renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} pluginPanels={panels} />);
        expect(withPanels).toContain('data-action="add-plugin-pane"');
        expect(withPanels).toContain('data-plugin-panel="acme.lint/report"');
        expect(withPanels).toContain('data-plugin-panel="acme.lint/config"');
        expect(renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} pluginPanels={[]} />)).not.toContain('data-action="add-plugin-pane"');
        expect(renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} />)).not.toContain('data-action="add-plugin-pane"');
    });

    it('an open plugin pane is a tab named by the panel and a grid slot mounting it', () => {
        const state = pluginOpened(terminalOpened(emptyWorkspace(), tab('t1'), ''), 'acme.lint', 'report');
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} pluginPanels={panels} initialState={state} />);
        expect(html).toContain('data-plugin-tab="plugin:acme.lint/report"');
        expect(html).toContain('data-pane-slot="plugin:acme.lint/report"');
        expect(html).toContain('data-pane-kind="plugin"');
        expect(html).toContain('data-plugin-pane="acme.lint/report"');
    });

    it('a pane whose plugin is no longer enabled says so instead of a blank slot', () => {
        const state = pluginOpened(terminalOpened(emptyWorkspace(), tab('t1'), ''), 'acme.gone', 'x');
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} pluginPanels={panels} initialState={state} />);
        expect(html).toContain('data-plugin-pane-missing="acme.gone/x"');
        expect(html).toMatch(/not enabled|no longer/);
    });
});
