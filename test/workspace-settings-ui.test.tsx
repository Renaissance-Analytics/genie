import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * WORKSPACE SETTINGS ON THE WORKSPACE SURFACE (§6.1). The settings registered with `scope: 'workspace'`
 * — default agent, approval gates, running-agents cap, who may message agents here — are edited where the
 * workspace is, with THIS workspace's effective values, and a row says when it is overriding the
 * workstation value. Nothing is drawn without the ops.
 */

const ops: WorkspaceOpsProps = {
    asleep: false, agentCount: 1, removePreview: false, lastOutcome: null,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    settings: {
        values: { default_agent: 'claude', approval_gates: 'writes', agent_cap: '2', inbox_access: 'self' },
        overridden: ['agent_cap'],
        onSet: () => {},
        onReset: () => {},
    },
};
const render = (o: WorkspaceOpsProps | undefined) =>
    renderToStaticMarkup(<Workspace view="settings" workspace={{ id: 'tynn', name: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} ops={o} />);

describe('workspace settings section', () => {
    it('lists every workspace-scoped setting with this workspace’s value; an override says so and offers a reset', () => {
        const html = render(ops);
        expect(html).toContain('data-workspace-settings');
        expect(html).toContain('data-ws-setting="agent_cap"');
        expect(html).toContain('data-ws-setting="inbox_access"');
        expect(html).toContain('data-ws-setting="default_agent"');
        expect(html).toContain('data-ws-setting="approval_gates"');
        expect(html).toMatch(/<option value="2" selected=""/);
        expect(html).toContain('data-ws-overridden="agent_cap"');
        expect(html).toContain('data-action="ws-setting-reset" data-ws-key="agent_cap"');
        expect(html).not.toContain('data-ws-overridden="inbox_access"');
        expect(html).not.toContain('data-ws-setting="theme"');
    });

    it('nothing without the settings ops; a skeleton while values are null', () => {
        expect(render({ ...ops, settings: undefined })).not.toContain('data-workspace-settings');
        expect(render({ ...ops, settings: { ...ops.settings!, values: null } })).toContain('data-ws-settings-skeleton');
    });
});

/**
 * THE DEFAULT AGENT — GENIE 1'S DROPDOWN (the owner, 2026-10-19; approved FTQ q_09d1f4a0). One of THIS workspace's agents,
 * or none; the agent an action uses when it names none. The provider setting is "Provider for new agents" — two rows
 * called "Default agent" would be two different things under one name.
 */
describe('the default agent', () => {
    const withDefault = (current: string | null) => ({ ...ops, defaultAgent: { agents: [{ id: 'a1', name: 'atlas' }, { id: 'a2', name: 'wren' }], current, onSet: () => {} } });

    it('a dropdown of this workspace’s agents and None, the current one selected', () => {
        const html = render(withDefault('a2'));
        const select = html.match(/<select[^>]*data-default-agent[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
        expect(select).not.toBe('');
        expect([...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(['', 'a1', 'a2']);
        expect(select).toMatch(/<option value="a2" selected=""/);
        expect(html).toMatch(/Default agent/);
    });

    it('none designated selects None', () => {
        expect(render(withDefault(null))).toMatch(/<select[^>]*data-default-agent[^>]*>\s*<option value="" selected=""/);
    });

    it('the provider setting is named for what it is', () => {
        const html = render(ops);
        expect(html).toMatch(/data-ws-setting="default_agent"[\s\S]*?Provider for new agents/);
    });
});
