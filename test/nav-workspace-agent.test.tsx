import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { routeWorkspace } from '../src/core/route.js';
import { workspaceViewRoute } from '../src/core/workspace-tabs.js';
import type { RailItem } from '../src/core/rail-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';
import { control } from './helpers/control-markup.js';
import { stripPick } from './helpers/strip-pick.js';

/**
 * WORKSPACE ↔ AGENT NAVIGATION, PART 1 (Tynn #805; the owner, 2026-10-17: "the workspace and agent views need to have
 * better navigation between them" — answered: agents open inside their workspace, as in Genie 1). This part: on an
 * agent's page you know where you are and can get back — its workspace stays the highlighted row in the sidebar, and
 * the workspace name in the agent's header is a link to it.
 */
const agents = [{ id: 'a1', workspaceId: 'tynn' }, { id: 'a2', workspaceId: 'fancy' }];

describe('which workspace a route belongs to', () => {
    it('the workspace itself, any of its views; an agent’s page is its workspace’s; anything else, none', () => {
        expect(routeWorkspace('genie://workspace/tynn', agents)).toBe('tynn');
        expect(routeWorkspace('genie://workspace/tynn?view=tab:t1&files=README.md', agents)).toBe('tynn');
        expect(routeWorkspace('genie://agent/a1?tab=stream', agents)).toBe('tynn');
        expect(routeWorkspace('genie://agent/a2', agents)).toBe('fancy');
        expect(routeWorkspace('genie://agent/unknown', agents)).toBeNull();
        expect(routeWorkspace('genie://dashboard', agents)).toBeNull();
    });
});

const ws = (id: string): RailItem => ({ id, path: `/w/${id}`, name: id, count: 1, alert: null } as RailItem);
const memory = (collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const sidebar = (route: string, collapsed: boolean) => renderToStaticMarkup(
    <Sidebar route={route} deckCount={0} workspaces={[ws('tynn'), ws('fancy')]} available={['dashboard', 'genie', 'workspace', 'settings']} onNavigate={() => {}} railStorage={memory(collapsed)} currentWorkspaceId={routeWorkspace(route, agents)} />,
);
const activeRows = (html: string): string[] => [...html.matchAll(/<button[^>]*data-nav="genie:\/\/workspace\/([a-z]+)"[^>]*data-active="true"/g)].map((m) => m[1]!);

describe('the sidebar keeps your place', () => {
    it('on an agent’s page its workspace is the highlighted row — expanded and collapsed; COUNTED: one', () => {
        expect(activeRows(sidebar('genie://agent/a1?tab=stream', false))).toEqual(['tynn']);
        expect(activeRows(sidebar('genie://agent/a1?tab=stream', true))).toEqual(['tynn']);
        expect(activeRows(sidebar('genie://agent/a2', false))).toEqual(['fancy']);
        // CONTROL: on the Dashboard, no workspace is.
        expect(activeRows(sidebar('genie://dashboard', false))).toEqual([]);
    });
});

describe('the agent’s bar leads back', () => {
    /*
     * The crumb "Tynn.ai /" was the way back until the one bar (the owner on beta.64: no row duplicating the tab name).
     * The agent's bar IS its workspace's strip, so the way back is that strip's Dashboard tab, one click, always there.
     */
    it('its workspace’s Dashboard tab is in the agent’s bar, and picking it opens that workspace', () => {
        const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
        const idle = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
        const opened: string[] = [];
        const strip = (trailing: ReactNode) => <WorkspaceTabs designed={{ tabs: [] }} agents={[{ id: 'a1', name: 'atlas', state: 'idle' }]} current={{ kind: 'agent', id: 'a1' }} canDesign hasSettings onView={(v) => opened.push(workspaceViewRoute('tynn', v))} onAdd={() => {}} onOpenAgent={() => {}} trailing={trailing} />;
        const html = renderToStaticMarkup(<AgentView agent={agent} session={idle} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} bar={strip} />);
        const bar = html.slice(html.indexOf('data-top-bar'), html.indexOf('data-view-body'));
        expect(control(bar, 'data-workspace-tab="home"')).toMatchObject({ tag: 'button', tab: true, text: 'Dashboard' });
        // Picking it: react-fancy Tabs' onTabChange with that tab's value; the strip asks for the workspace's home view.
        const el = WorkspaceTabs({ designed: { tabs: [] }, agents: [], current: { kind: 'agent', id: 'a1' }, canDesign: true, hasSettings: true, onView: (v) => opened.push(workspaceViewRoute('tynn', v)), onAdd: () => {}, onOpenAgent: () => {} });
        stripPick(el)('home');
        expect(opened).toEqual(['genie://workspace/tynn']);
    });
});

