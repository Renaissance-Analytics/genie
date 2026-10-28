import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { chatSubjectFor } from '../src/core/chat-scope.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { parseRoute } from '../src/core/route.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { DashboardProps } from '../src/renderer/components/Dashboard.js';

/**
 * CLICKING AN AGENT ON THE DASHBOARD KEEPS THE DASHBOARD; THE DOCKED CHAT BECOMES THAT AGENT'S (the owner, 2026-10-28:
 * "why is clicking an agent in the dashboard taking me to the deck now? Dashboard should stay active while the chat
 * changes to that agent chat so I can quickly discuss things with multiple agents without having to jump from workspace
 * to workspace").
 *
 * genie#1209 made a row click pick the chat — but only for an agent with nothing pending. A row whose agent held ANY
 * blocking `agent-question` Deck item (a ForceTheQuestion, a permission approval, a Genie-gated action — and a STALE
 * question its agent no longer waits on) still left for `genie://deck?item=…` (fb4cbb24, §4.1's "door"). Agents that
 * ask are the ones the person most wants to talk to, so the click left the board exactly when it mattered.
 *
 * Genie 1 (v0.7.0-beta.342) never let a pending question redirect an agent click: the rail's agent square
 * (`renderer/components/Master/Chooser.tsx` onOpen → `master.tsx` openSpec) opened that agent and nothing else; its
 * questions were answered in their own window or the Question Inbox flyout. The Deck item is still reachable from the
 * Deck, the approval toasts and the chat itself.
 *
 * This drives the real `Shell`: the Dashboard's `onOpenAgent` it wires, then the route and the chat's subject that App
 * derives from what that handler did.
 */

const captured: DashboardProps[] = [];
vi.mock('../src/renderer/components/Dashboard.js', async (original) => {
    const real = await original<typeof import('../src/renderer/components/Dashboard.js')>();
    const Dashboard = (props: DashboardProps) => { captured.push(props); return real.Dashboard(props); };
    return { ...real, Dashboard };
});
const { Shell } = await import('../src/renderer/Shell.js');

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
const ROUTE = 'genie://dashboard?group=workspace';

function clickRow(agentId: string, deckItems: readonly DeckItem[]) {
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
        onOpenAgent={(id) => opened.push(id)} onChatAgent={(id) => chatted.push(id)}
        onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}}
        onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
    />);
    const dashboard = captured.at(-1);
    if (!dashboard) throw new Error('the Shell did not render the Dashboard for a dashboard route');
    dashboard.onOpenAgent(agentId);
    // App: `onChatAgent` is `setDashboardChat`, and the route is whatever was navigated to last (none = unchanged).
    const route = navigated.at(-1) ?? ROUTE;
    const picked = chatted.at(-1) ?? null;
    const parsed = parseRoute(route);
    const subject = chatSubjectFor(parsed, snapshot.agents.concat(snapshot.osAgent!), [], parsed.surface === 'dashboard' ? picked : null);
    return { navigated, opened, surface: parsed.surface, subject };
}

describe('a Dashboard agent click', () => {
    it('CONTROL: an agent with nothing pending — the Dashboard stays and the chat is that agent’s', () => {
        const r = clickRow('a_wren', []);
        expect(r.navigated).toEqual([]);
        expect(r.opened).toEqual([]);
        expect(r.surface).toBe('dashboard');
        expect(r.subject).toBe('a_wren');
    });

    it('an agent WAITING on a question: the Dashboard stays (never the Deck) and the chat is that agent’s', () => {
        const r = clickRow('a_kai', [question({})]);
        expect(r.navigated).toEqual([]);
        expect(r.opened).toEqual([]);
        expect(r.surface).toBe('dashboard');
        expect(r.subject).toBe('a_kai');
    });

    it('an agent with a parked permission approval: the same — the chat answers approvals too', () => {
        const approval = question({ id: 'approval:a_kai', answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] } });
        const r = clickRow('a_kai', [approval]);
        expect(r.navigated).toEqual([]);
        expect(r.surface).toBe('dashboard');
        expect(r.subject).toBe('a_kai');
    });

    it('an agent whose question is STALE (it no longer waits): the same', () => {
        const r = clickRow('a_kai', [question({ stale: 'session-ended' })]);
        expect(r.navigated).toEqual([]);
        expect(r.surface).toBe('dashboard');
        expect(r.subject).toBe('a_kai');
    });

    it('clicking one agent, then another, swaps the chat each time and never leaves the Dashboard', () => {
        for (const id of ['a_kai', 'a_wren', 'a_genie', 'a_kai']) {
            const r = clickRow(id, [question({})]);
            expect(r.navigated).toEqual([]);
            expect(r.surface).toBe('dashboard');
            expect(r.subject).toBe(id);
        }
    });
});
