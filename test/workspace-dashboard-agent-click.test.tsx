import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { chatSubjectFor } from '../src/core/chat-scope.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { parseRoute } from '../src/core/route.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { WorkspaceDashboardProps } from '../src/renderer/components/WorkspaceDashboard.js';

/**
 * CLICKING AN AGENT IN A WORKSPACE'S OWN DASHBOARD OPENS THAT AGENT'S TAB, AND THE DOCKED CHAT FOLLOWS (the owner,
 * 2026-10-29: "chat is always present no matter what page we are on. if I am clicking on an agent in a workspace
 * dashboard then I go to that agent tab that shows the activity and chat stream. if I am clicking an agent in the Genie
 * Dashboard then it just changes the active chat").
 *
 * The Genie Dashboard half is genie#1327 (test/dashboard-agent-click-stays.test.tsx). This is the other half: a lane of
 * the workspace dashboard is the door to `genie://agent/<id>?tab=stream` — its activity and chat stream — and the docked
 * chat's subject becomes that agent. Never the Deck, even for an agent holding a blocking question, a parked approval or
 * a stale question: that was #1327's bug class (a pending item redirecting an agent click), and it must not reach here.
 *
 * This drives the real `Shell` on a workspace route, the real `WorkspaceDashboard` it renders, and the real lane's
 * onClick / onKeyDown; then derives the route and the chat subject the way App does (App's `onOpenAgent` opens the agent
 * and navigates to `genie://agent/<id>?tab=stream`; `onChatAgent` is `setDashboardChat`, which only counts on the
 * Dashboard).
 */

const captured: WorkspaceDashboardProps[] = [];
vi.mock('../src/renderer/components/WorkspaceDashboard.js', async (original) => {
    const real = await original<typeof import('../src/renderer/components/WorkspaceDashboard.js')>();
    const WorkspaceDashboard = (props: WorkspaceDashboardProps) => { captured.push(props); return real.WorkspaceDashboard(props); };
    return { ...real, WorkspaceDashboard };
});
const { Shell } = await import('../src/renderer/Shell.js');
const { WorkspaceDashboard } = await import('../src/renderer/components/WorkspaceDashboard.js');

const row = (id: string, state: AgentRow['state'] = 'working'): AgentRow => ({
    id, name: id, workspaceId: 'ws', state, provider: 'claude', fidelity: 'declared', duration: null,
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const question = (over: Partial<DeckItem>): DeckItem => ({
    id: 'q_1', source: 'agent-question', agentId: 'a_kai', agentName: 'kai', workspaceId: 'ws',
    title: 'Ship it?', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: 1, questions: [] }, forwardedFrom: null, ...over,
});
const ROUTE = 'genie://workspace/ws';

/** Every element in a tree, rendering function components that carry a lane (the Lane is not exported). */
function lanes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode): void => {
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (!isValidElement(n)) return;
        const el = n as ReactElement<Record<string, unknown>>;
        if (typeof el.type === 'function' && el.props.lane !== undefined) { walk((el.type as unknown as (p: unknown) => ReactNode)(el.props)); return; }
        if (typeof el.props['data-dash-lane'] === 'string') out.push(el);
        walk(el.props.children as ReactNode);
    };
    walk(node);
    return out;
}

type How = 'click' | 'Enter' | 'Space';

function activateLane(agentId: string, deckItems: readonly DeckItem[], how: How) {
    const snapshot: GenieSnapshot = {
        ...EMPTY_SNAPSHOT,
        workspaces: [{ id: 'ws', name: 'Tynn', path: '/fixture/ws', agentsKnown: true }],
        agents: [row('a_kai', 'waiting'), row('a_wren')],
        osAgent: row('a_genie'),
        deckItems,
    };
    const navigated: string[] = [];
    const chatted: string[] = [];
    const opened: string[] = [];
    captured.length = 0;
    renderToStaticMarkup(<Shell route={ROUTE} snapshot={snapshot}
        servable={['dashboard', 'deck', 'agent', 'workspace']} agentDetail={null} agentResolved={false}
        selectedRowId={null} chatThread={null} pinned={null} onNavigate={(r) => navigated.push(r)}
        // App's onOpenAgent: start or reattach, then the agent's page on its stream.
        onOpenAgent={(id) => { opened.push(id); navigated.push(`genie://agent/${id}?tab=stream`); }}
        onChatAgent={(id) => chatted.push(id)}
        onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}}
        onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
    />);
    const props = captured.at(-1);
    if (!props) throw new Error('the Shell did not render the workspace dashboard for a workspace route');
    const lane = lanes(WorkspaceDashboard(props)).find((l) => l.props['data-dash-lane'] === agentId);
    if (!lane) throw new Error(`no lane for ${agentId} on the workspace dashboard`);
    if (how === 'click') (lane.props.onClick as () => void)();
    else {
        const target = {};
        let prevented = false;
        (lane.props.onKeyDown as (e: unknown) => void)({ key: how === 'Enter' ? 'Enter' : ' ', target, currentTarget: target, preventDefault: () => { prevented = true; } });
        expect(prevented).toBe(true);
    }
    const route = navigated.at(-1) ?? ROUTE;
    const parsed = parseRoute(route);
    const subject = chatSubjectFor(parsed, snapshot.agents.concat(snapshot.osAgent!), snapshot.workspaces ?? [], parsed.surface === 'dashboard' ? (chatted.at(-1) ?? null) : null);
    return { navigated, opened, parsed, subject };
}

const expectAgentTab = (r: ReturnType<typeof activateLane>, id: string) => {
    expect(r.navigated).toEqual([`genie://agent/${id}?tab=stream`]);
    expect(r.navigated.some((n) => n.startsWith('genie://deck'))).toBe(false);
    expect(r.opened).toEqual([id]);
    expect(r.parsed.surface).toBe('agent');
    expect(r.parsed.surface === 'agent' && r.parsed.agentId).toBe(id);
    expect(r.parsed.surface === 'agent' && r.parsed.tab).toBe('stream');
    expect(r.subject).toBe(id);
};

describe('a workspace dashboard agent click', () => {
    it('CONTROL: before any click the docked chat is the workspace’s default agent, not the one clicked next', () => {
        const parsed = parseRoute(ROUTE);
        expect(parsed.surface).toBe('workspace');
        expect(chatSubjectFor(parsed, [row('a_kai', 'waiting'), row('a_wren'), row('a_genie')], [{ id: 'ws', defaultAgentId: 'a_kai' }])).toBe('a_kai');
    });

    for (const how of ['click', 'Enter', 'Space'] as const) {
        it(`${how}: an agent with nothing pending opens its tab (stream) and the chat follows`, () => {
            expectAgentTab(activateLane('a_wren', [], how), 'a_wren');
        });

        it(`${how}: an agent WAITING on a question opens its tab, never the Deck, and the chat follows`, () => {
            expectAgentTab(activateLane('a_kai', [question({})], how), 'a_kai');
        });

        it(`${how}: an agent with a parked permission approval — the same`, () => {
            const approval = question({ id: 'approval:a_kai', answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] } });
            expectAgentTab(activateLane('a_kai', [approval], how), 'a_kai');
        });

        it(`${how}: an agent whose question is STALE — the same`, () => {
            expectAgentTab(activateLane('a_kai', [question({ stale: 'session-ended' })], how), 'a_kai');
        });
    }

    it('a key press on a control INSIDE the lane does not open the agent (the lane only answers its own keys)', () => {
        const props = (() => { activateLane('a_wren', [], 'click'); return captured.at(-1)!; })();
        const opened: string[] = [];
        const lane = lanes(WorkspaceDashboard({ ...props, onOpenAgent: (id) => opened.push(id) })).find((l) => l.props['data-dash-lane'] === 'a_wren')!;
        (lane.props.onKeyDown as (e: unknown) => void)({ key: 'Enter', target: {}, currentTarget: {}, preventDefault: () => {} });
        expect(opened).toEqual([]);
    });
});
