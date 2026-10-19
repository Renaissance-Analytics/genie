import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * WORKSPACE SETTINGS, ONE WORKSPACE'S OWN PAGE (the owner, 2026-10-19: "Genie should have 3 primary settings views —
 * Workstation, Workspace, and Agent. Other features that have config like bg process and sites can open those config
 * screens in modals like genie 1 did"; approved FTQ q_09d1f4a0). The same language as the Workstation pages: titled cards,
 * Fancy controls — and a Hosting card whose buttons open this workspace's Background processes and Sites modals.
 */

const values = Object.fromEntries(SETTINGS.filter((s) => s.scope === 'workspace').map((s) => [s.key, s.default]));
const ops: WorkspaceOpsProps = {
    asleep: false, agentCount: 2, removePreview: false, lastOutcome: null,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    settings: { values, overridden: [], onSet: () => {}, onReset: () => {} },
    defaultAgent: { agents: [{ id: 'a1', name: 'atlas' }], current: 'a1', onSet: () => {} },
    repos: { list: [], onAdd: () => {}, onRemove: () => {}, onRemoveLock: () => {}, onOpen: () => {} },
} as WorkspaceOpsProps;
const render = (withRuntime = true) =>
    renderToStaticMarkup(<Workspace view="settings" workspace={{ id: 'tynn', name: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} ops={ops} {...(withRuntime ? { onOpenRuntime: () => {} } : {})} />);

describe('one workspace’s settings page', () => {
    it('titled cards, in order: General, Hosting, Repos (COUNTED)', () => {
        const html = render();
        const cards = [...html.matchAll(/data-ws-card="([a-z-]+)"/g)].map((m) => m[1]);
        expect(cards).toEqual(['general', 'hosting', 'repos']);
        expect(html).toMatch(/data-ws-card="general"[\s\S]*?<h2[^>]*>General<\/h2>/);
    });

    it('the Hosting card opens this workspace’s Background processes and Sites (Genie 1’s modals)', () => {
        const html = render();
        expect(html).toMatch(/data-ws-card="hosting"[\s\S]*?data-action="ws-open-processes"[\s\S]*?data-action="ws-open-sites"/);
        // CONTROL: without the opener there is no Hosting card — never buttons that open nothing.
        expect(render(false)).not.toContain('data-ws-card="hosting"');
    });

    it('Fancy controls: a Switch per boolean and Selects for choices — no bare checkbox or select in General', () => {
        const general = render().match(/data-ws-card="general"[\s\S]*?(?=data-ws-card="hosting")/)?.[0] ?? '';
        expect(general).toContain('data-react-fancy-switch');
        expect(general).toContain('data-react-fancy-select');
        expect(general).not.toMatch(/<input type="checkbox"/);
    });
});
