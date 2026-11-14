import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { chatSubjectFor } from '../src/core/chat-scope.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { parseRoute } from '../src/core/route.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { SidebarProps } from '../src/renderer/components/Sidebar.js';

/**
 * THE SIDEBAR'S AGENT LIST PICKS THE CHAT, AND THE WORKSPACE ON SCREEN STAYS (Tynn #687; the owner, 2026-11-13: "I need a
 * way to quickly select agents without switching workspaces").
 *
 * This drives the real `Shell`: the roster and the click handler it hands the Sidebar, then the route and the chat's subject
 * that App derives from what that handler did — the same path the Dashboard's row click takes (genie#1209,
 * test/dashboard-agent-click-stays.test.tsx).
 */
const captured: SidebarProps[] = [];
vi.mock('../src/renderer/components/Sidebar.js', async (original) => {
    const real = await original<typeof import('../src/renderer/components/Sidebar.js')>();
    const Sidebar = (props: SidebarProps) => { captured.push(props); return real.Sidebar(props); };
    return { ...real, Sidebar };
});
const { Shell } = await import('../src/renderer/Shell.js');

const row = (id: string, workspaceId: string): AgentRow => ({
    id, name: id, workspaceId, state: 'idle', provider: 'claude', fidelity: 'declared', duration: null,
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const ROUTE = 'genie://workspace/ws_alpha';
const snapshot: GenieSnapshot = {
    ...EMPTY_SNAPSHOT,
    workspaces: [
        { id: 'ws_alpha', name: 'alpha', path: '/fixture/alpha', agentsKnown: true },
        { id: 'ws_beta', name: 'beta', path: '/fixture/beta', agentsKnown: true },
    ],
    hibernatedWorkspaces: [{ id: 'ws_zz', name: 'zz', path: '/fixture/zz', asleep: true }],
    agents: [row('a_atlas', 'ws_alpha'), row('a_lark', 'ws_beta'), row('a_ghost', 'ws_zz')],
    osAgent: row('a_genie', '__genie__'),
};

function render() {
    const navigated: string[] = [];
    const chatted: string[] = [];
    const opened: string[] = [];
    captured.length = 0;
    renderToStaticMarkup(<Shell route={ROUTE} snapshot={snapshot}
        servable={['dashboard', 'deck', 'agent', 'workspace']} agentDetail={null} agentResolved={false}
        selectedRowId={null} chatThread={null} pinned={null} files={NO_FILES} onNavigate={(r) => navigated.push(r)}
        onOpenAgent={(id) => opened.push(id)} onChatAgent={(id) => chatted.push(id)}
        onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}}
        onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
    />);
    const sidebar = captured.at(-1);
    if (!sidebar) throw new Error('the Shell did not render the Sidebar');
    return { sidebar, navigated, chatted, opened };
}

describe('the Shell wires the sidebar’s agent list', () => {
    it('hands it every agent of a workspace that is awake — never a hibernated workspace’s (control: the roster has one)', () => {
        const { sidebar } = render();
        expect(snapshot.agents.some((a) => a.id === 'a_ghost')).toBe(true);
        expect((sidebar.agents ?? []).map((a) => a.id).sort()).toEqual(['a_atlas', 'a_lark']);
    });

    it('a click on another workspace’s agent picks the chat, navigates nowhere, and the workspace on screen stays', () => {
        const { sidebar, navigated, chatted, opened } = render();
        expect(sidebar.onChatAgent).toBeTypeOf('function');
        sidebar.onChatAgent!('a_lark');
        expect(navigated).toEqual([]);
        expect(opened).toEqual([]);
        expect(chatted).toEqual(['a_lark']);
        // App: `onChatAgent` is the window's chat pick; the route is unchanged, so the workspace on screen is too.
        const parsed = parseRoute(navigated.at(-1) ?? ROUTE);
        expect(parsed).toMatchObject({ surface: 'workspace', workspaceId: 'ws_alpha' });
        expect(chatSubjectFor(parsed, snapshot.agents.concat(snapshot.osAgent!), chatted.at(-1) ?? null)).toBe('a_lark');
    });
});
