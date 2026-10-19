import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RailItem } from '../src/core/rail-view.js';
import { routeWorkspace } from '../src/core/route.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE SIDEBAR LISTS WORKSPACES, NOT AGENTS (the owner, 2026-10-19: "why is the workspace sidebar opening an agent tree?
 * I never asked for this"). The agent list under the workspace you are in came from a nav proposal's extras, never from
 * the owner; it is gone. On an agent's page the sidebar still says where you are: that agent's workspace stays marked.
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
// Handed the whole roster, as Shell once passed it: the sidebar must still draw no agent.
const sidebar = (route: string, collapsed = false) => renderToStaticMarkup(
    <Sidebar route={route} deckCount={0} workspaces={[ws('tynn'), ws('fancy')]} available={['deck', 'dashboard', 'genie', 'workspace', 'settings']} onNavigate={() => {}} railStorage={memory(collapsed)} currentWorkspaceId={routeWorkspace(route, agents)} {...({ agents } as object)} />,
);
const workspaceRow = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-workspace="${id}"[^>]*>`))?.[0] ?? '';

describe('the sidebar lists workspaces, not agents', () => {
    it('no agent rows anywhere — on an agent’s page, on its workspace, on the Dashboard, collapsed (COUNTED: 0)', () => {
        for (const html of [sidebar('genie://agent/a1?tab=stream'), sidebar('genie://workspace/tynn'), sidebar('genie://dashboard'), sidebar('genie://agent/a1', true)]) {
            expect(html.match(/data-rail-agent=/g) ?? []).toHaveLength(0);
            for (const a of agents) expect(html).not.toContain(`genie://agent/${a.id}`);
        }
    });

    it('on an agent’s page its workspace stays marked, and only that one (the positive control: the rows are drawn)', () => {
        const html = sidebar('genie://agent/a1?tab=stream');
        expect(workspaceRow(html, 'tynn')).toContain('data-active="true"');
        expect(workspaceRow(html, 'fancy')).toContain('data-active="false"');
    });
});
