import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { addTab, agentTabsOf, tabStrip, type TabsState } from '../src/core/workspace-tabs.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * AGENTS OPEN INSIDE THEIR WORKSPACE (Tynn #805, part 2; the owner chose A, 2026-10-17: "agents open inside the
 * workspace" — as in Genie 1, where an agent lived in its workspace). An agent's page is drawn under ITS workspace's tab
 * strip: Dashboard · EVERY agent of the workspace · your tabs · + · Settings. Each agent is a tab with its state; the one
 * you are on is current. Switching to a sibling, or back to the workspace, its tabs or Settings, is one click.
 *
 * EVERY agent, not the ones you opened (the owner, 2026-10-20, after beta.32: "WTF happened to my agent tabs in the
 * workspace? I have no fucking way to select different agents now" — and "one an agent starts up if I select them from
 * the dashboard then I get the agent tab"). Opened-only tabs came from Tynn #805; the first tab used to LIST the agents,
 * and when it became the Dashboard (running agents only) an idle agent had no door at all — after an upgrade, none did.
 */
const empty: TabsState = { tabs: [] };

describe('the strip', () => {
    it('Dashboard (the workspace dashboard, q_09d1f4a0), the workspace’s agents, your tabs, +, Settings', () => {
        const designed = addTab(empty, 'Ops').state;
        const strip = tabStrip(designed, [{ id: 'a1', name: 'atlas' }, { id: 'a2', name: 'wren' }]);
        expect(strip.map((t) => (t.kind === 'agent' ? `@${t.name}` : t.kind === 'designed' ? t.name : t.kind))).toEqual(['dashboard', '@atlas', '@wren', 'Ops', 'add', 'settings']);
        // CONTROL: a workspace with no agents — the strip without agent tabs.
        expect(tabStrip(designed).map((t) => t.kind)).toEqual(['dashboard', 'designed', 'add', 'settings']);
    });
});

describe('which agents are tabs: every agent of the workspace', () => {
    const roster = [
        { id: 'a1', name: 'atlas', workspaceId: 'tynn', state: 'working' },
        { id: 'a2', name: 'wren', workspaceId: 'tynn', state: 'stopped' },
        { id: 'b1', name: 'kora', workspaceId: 'fancy', state: 'idle' },
        { id: 'a3', name: 'zane', workspaceId: 'tynn', state: 'idle' },
    ];

    it('nothing opened, as after an upgrade: every agent of the workspace — a STOPPED one included — in roster order', () => {
        expect(agentTabsOf(roster, 'tynn').map((a) => a.name)).toEqual(['atlas', 'wren', 'zane']);
        expect(agentTabsOf(roster, 'tynn').find((a) => a.id === 'a2')?.state).toBe('stopped');
    });

    it('CONTROL: another workspace’s agents are not here, and an empty workspace has none', () => {
        expect(agentTabsOf(roster, 'fancy').map((a) => a.name)).toEqual(['kora']);
        expect(agentTabsOf(roster, 'empty')).toEqual([]);
    });
});

describe('the strip, drawn', () => {
    const agents = [{ id: 'a1', name: 'atlas', state: 'working' }, { id: 'a2', name: 'wren', state: 'idle' }];
    const render = (current: { kind: 'agent'; id: string } | { kind: 'view'; view: string }) => renderToStaticMarkup(
        <WorkspaceTabs designed={addTab(empty, 'Ops').state} agents={agents} current={current} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} />,
    );

    it('on an agent: its tab is current; the others, the workspace’s tabs and Settings are there to go to; COUNTED', () => {
        const html = render({ kind: 'agent', id: 'a1' });
        expect(html).toContain('data-workspace-tabs=""');
        expect(html.match(/data-workspace-tab="agent:/g)).toHaveLength(2);
        expect(html).toMatch(/data-workspace-tab="agent:a1"[^>]*data-current="true"/);
        expect(html).not.toMatch(/data-workspace-tab="agent:a2"[^>]*data-current="true"/);
        expect(html.match(/data-current="true"/g)).toHaveLength(1);
        for (const v of ['home', 'settings']) expect(html).toContain(`data-workspace-tab="${v}"`);
        expect(html).toMatch(/data-workspace-tab="tab:[^"]+"[^>]*>Ops</);
        // Each agent tab says its state; none is closed away (it is the agent's only door).
        expect(html).not.toContain('data-close-agent-tab');
        expect(html).toMatch(/data-workspace-tab="agent:a1"[\s\S]*?data-agent-state="working"/);
    });

    it('on a workspace view: that view is current and no agent is', () => {
        const html = render({ kind: 'view', view: 'home' });
        expect(html).toMatch(/data-workspace-tab="home"[^>]*data-current="true"/);
        expect(html.match(/data-current="true"/g)).toHaveLength(1);
        // The first tab is the workspace DASHBOARD, and says so (the owner: not "Agents").
        expect(html).toMatch(/data-workspace-tab="home"[^>]*>Dashboard</);
        expect(html).not.toMatch(/>Agents</);
    });
});
