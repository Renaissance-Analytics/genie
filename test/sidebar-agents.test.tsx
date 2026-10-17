import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RailItem } from '../src/core/rail-view.js';
import { routeWorkspace } from '../src/core/route.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * WORKSPACE ↔ AGENT NAVIGATION, PART 3 (Tynn #805; the owner chose agents inside their workspace, as in Genie 1): the
 * sidebar lists the agents of the workspace you are in, under its row — each with its state, one click to open it,
 * the one you are on marked. Only the workspace you are in opens out; the others stay one row each.
 */
const agents = [
    { id: 'a1', name: 'atlas', workspaceId: 'tynn', state: 'working' },
    { id: 'a2', name: 'wren', workspaceId: 'tynn', state: 'idle' },
    { id: 'a3', name: 'kai', workspaceId: 'fancy', state: 'waiting' },
];
const ws = (id: string): RailItem => ({ id, path: `/w/${id}`, name: id, count: 1, alert: null } as RailItem);
const memory = (collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const sidebar = (route: string, collapsed = false) => renderToStaticMarkup(
    <Sidebar route={route} deckCount={0} workspaces={[ws('tynn'), ws('fancy')]} available={['deck', 'dashboard', 'genie', 'workspace', 'settings']} onNavigate={() => {}} railStorage={memory(collapsed)} currentWorkspaceId={routeWorkspace(route, agents)} agents={agents} />,
);
const agentRows = (html: string) => [...html.matchAll(/<button[^>]*data-rail-agent="([a-z0-9]+)"[^>]*>/g)].map((m) => ({ id: m[1]!, active: /data-active="true"/.test(m[0]), nav: m[0].match(/data-nav="([^"]+)"/)?.[1] }));

describe('the sidebar lists the agents of the workspace you are in', () => {
    it('on an agent’s page: its workspace’s agents, under it, each opening its page; the one you are on marked; COUNTED', () => {
        const rows = agentRows(sidebar('genie://agent/a1?tab=stream'));
        expect(rows).toEqual([
            { id: 'a1', active: true, nav: 'genie://agent/a1' },
            { id: 'a2', active: false, nav: 'genie://agent/a2' },
        ]);
    });

    it('they sit right under their workspace’s row, before the next workspace; each says its state', () => {
        const html = sidebar('genie://workspace/tynn');
        const tynn = html.indexOf('data-workspace="tynn"');
        const fancy = html.indexOf('data-workspace="fancy"');
        expect(html.indexOf('data-rail-agent="a1"')).toBeGreaterThan(tynn);
        expect(html.indexOf('data-rail-agent="a2"')).toBeLessThan(fancy);
        expect(html).toMatch(/data-rail-agent="a1"[\s\S]*?data-agent-state="working"/);
        // On the workspace's own page none of its agents is the current one.
        expect(agentRows(html).filter((r) => r.active)).toEqual([]);
    });

    it('only the workspace you are in opens out; CONTROL: on the Dashboard, no agents are listed', () => {
        expect(agentRows(sidebar('genie://agent/a3')).map((r) => r.id)).toEqual(['a3']);
        expect(agentRows(sidebar('genie://dashboard'))).toEqual([]);
    });

    it('the collapsed icon rail stays icons only: no agent rows', () => {
        expect(agentRows(sidebar('genie://agent/a1', true))).toEqual([]);
    });
});
