import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MAX_OPEN_AGENTS, addTab, openAgentTabs, tabStrip, type TabsState } from '../src/core/workspace-tabs.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * AGENTS OPEN INSIDE THEIR WORKSPACE (Tynn #805, part 2; the owner chose A, 2026-10-17: "agents open inside the
 * workspace" — as in Genie 1, where an agent lived in its workspace). An agent's page is drawn under ITS workspace's tab
 * strip: Agents · the agents you opened · your tabs · + · Settings. Each opened agent is a tab with its state and a ×;
 * the one you are on is current. Switching to a sibling, or back to the workspace, its tabs or Settings, is one click.
 */
const empty: TabsState = { tabs: [] };

describe('the strip', () => {
    it('Agents, the opened agents in the order opened, your tabs, +, Settings', () => {
        const designed = addTab(empty, 'Ops').state;
        const strip = tabStrip(designed, [{ id: 'a1', name: 'atlas' }, { id: 'a2', name: 'wren' }]);
        expect(strip.map((t) => (t.kind === 'agent' ? `@${t.name}` : t.kind === 'designed' ? t.name : t.kind))).toEqual(['agents', '@atlas', '@wren', 'Ops', 'add', 'settings']);
        // CONTROL: no agents opened — the strip as it was.
        expect(tabStrip(designed).map((t) => t.kind)).toEqual(['agents', 'designed', 'add', 'settings']);
    });
});

describe('which agents are open as tabs', () => {
    const roster = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    it('the agent you open joins at the end, once; a gone agent drops out', () => {
        expect(openAgentTabs([], 'a1', roster)).toEqual(['a1']);
        expect(openAgentTabs(['a1'], 'a2', roster)).toEqual(['a1', 'a2']);
        expect(openAgentTabs(['a1', 'a2'], 'a1', roster)).toEqual(['a1', 'a2']);
        expect(openAgentTabs(['a1', 'gone', 'a2'], null, roster)).toEqual(['a1', 'a2']);
    });

    it('at most MAX_OPEN_AGENTS: the oldest gives way — never the one you are on', () => {
        expect(MAX_OPEN_AGENTS).toBe(6);
        expect(openAgentTabs(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], 'a7', roster)).toEqual(['a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
    });
});

describe('the strip, drawn', () => {
    const agents = [{ id: 'a1', name: 'atlas', state: 'working' }, { id: 'a2', name: 'wren', state: 'idle' }];
    const render = (current: { kind: 'agent'; id: string } | { kind: 'view'; view: string }) => renderToStaticMarkup(
        <WorkspaceTabs designed={addTab(empty, 'Ops').state} openAgents={agents} current={current} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} onCloseAgent={() => {}} />,
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
        // Each agent tab can be closed, and says its state.
        expect(html.match(/data-close-agent-tab="/g)).toHaveLength(2);
        expect(html).toMatch(/data-workspace-tab="agent:a1"[\s\S]*?data-agent-state="working"/);
    });

    it('on a workspace view: that view is current and no agent is', () => {
        const html = render({ kind: 'view', view: 'home' });
        expect(html).toMatch(/data-workspace-tab="home"[^>]*data-current="true"/);
        expect(html.match(/data-current="true"/g)).toHaveLength(1);
    });
});
