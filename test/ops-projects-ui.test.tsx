import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * OPS PROJECTS ON THE SURFACES (§6.1). The rail indents a governed workspace under its governor and says
 * so; the Dashboard's group header names the governor; the Workspace surface of an ops project has a
 * Governs control listing every other workspace with a checkbox. None of it is drawn when nothing governs.
 */

describe('Sidebar', () => {
    it('marks a governed row with its governor and indents it; an ungoverned row has no mark', () => {
        const html = renderToStaticMarkup(<Sidebar route="genie://dashboard" deckCount={0} workspaces={[{ id: 'ops', path: '/w/ops', count: 1, alert: false }, { id: 'fancy', path: '/w/fancy', count: 2, alert: false, governedBy: 'ops' }]} available={['deck', 'dashboard', 'genie', 'workspace']} onNavigate={() => {}} />);
        expect(html).toContain('data-workspace="fancy" data-governed-by="ops"');
        expect(html).not.toMatch(/data-workspace="ops" data-governed-by/);
    });
});

describe('Dashboard', () => {
    const row = (id: string, workspaceId: string): AgentRow => ({
        id, name: id, provider: 'claude', workspaceId, fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null,
        activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
    });
    it('names the governor in the group header of a governed workspace only', () => {
        const html = renderToStaticMarkup(<Dashboard rows={[row('a', 'fancy'), row('b', 'ops')]} workspaces={[{ id: 'ops', path: '/w/ops' }, { id: 'fancy', path: '/w/fancy', governedBy: 'ops' }]} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} />);
        expect(html).toContain('data-governed-by="ops"');
        expect(html).toMatch(/governed by ops/);
        expect((html.match(/governed by/g) ?? []).length).toBe(1);
    });
});

describe('Workspace surface', () => {
    const ops: WorkspaceOpsProps = {
        asleep: false, agentCount: 0, removePreview: false, lastOutcome: null,
        onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
        governs: { children: ['fancy'], candidates: [{ id: 'fancy' }, { id: 'prism' }], onSet: () => {} },
    };
    const render = (o: WorkspaceOpsProps | null) =>
        renderToStaticMarkup(<Workspace workspace={{ id: 'ops', path: '/w/ops' }} terminals={NO_TERMINALS} ops={o ?? undefined} />);

    it('lists every other workspace with a checkbox, the governed ones checked; absent without the ops', () => {
        const html = render(ops);
        expect(html).toContain('data-governs');
        expect(html).toMatch(/data-govern-child="fancy"[^>]*checked=""/);
        expect(html).toMatch(/data-govern-child="prism"/);
        expect(html).not.toMatch(/data-govern-child="prism"[^>]*checked=""/);
        expect(html).toMatch(/An ops project governs/);
        expect(render({ ...ops, governs: undefined })).not.toContain('data-governs');
    });
});
