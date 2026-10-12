import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../src/core/workspace-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * LAYOUT MODES ON THE WORKSPACE SURFACE (§6.5). A four-way control in the strip; the pane area is a grid
 * with one slot per visible terminal (the pane itself loads client-side, so the slots are what render
 * here). The mode comes from the workspace's own `panel_layout` setting and changing it writes it back.
 */

const tab = (id: string) => ({ id, workspaceId: 'tynn', shell: 'sh', pid: 1, exited: null });
const state: WorkspaceState = { terminals: [tab('t1'), tab('t2'), tab('t3')], active: 't2', output: {}, hidden: [] };
const ops = (layout: string): WorkspaceOpsProps => ({
    asleep: false, agentCount: 0, removePreview: false, lastOutcome: null,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    settings: { values: { panel_layout: layout }, overridden: [], onSet: () => {}, onReset: () => {} },
});
// `null` means "no ops at all" — a default parameter would swallow `undefined`, which is how this test once tested nothing.
const render = (layout: string, o: WorkspaceOpsProps | null = ops(layout)) =>
    renderToStaticMarkup(<Workspace view="terminals" workspace={{ id: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} initialState={state} ops={o ?? undefined} />);

describe('layout modes', () => {
    it('grid shows one slot per visible terminal; single shows one; the grid carries its template', () => {
        const grid = render('grid');
        expect(grid).toContain('data-layout="grid"');
        expect((grid.match(/data-pane-slot="/g) ?? []).length).toBe(3);
        expect(grid).toMatch(/grid-template-columns:repeat\(2, minmax\(0, 1fr\)\)/);
        const single = render('single');
        expect(single).toContain('data-layout="single"');
        expect((single.match(/data-pane-slot="/g) ?? []).length).toBe(1);
        expect(single).toContain('data-pane-slot="t2"');
    });

    it('the four-way control marks the current mode; with no settings ops it still renders single and no control', () => {
        const html = render('rows');
        expect(html).toContain('data-action="layout-single"');
        expect(html).toContain('data-action="layout-columns"');
        expect(html).toContain('data-action="layout-rows" data-current="true"');
        expect(html).toContain('data-action="layout-grid"');
        const bare = render('grid', null);
        expect(bare).toContain('data-layout="single"');
        expect(bare).not.toContain('data-action="layout-grid"');
    });
});
