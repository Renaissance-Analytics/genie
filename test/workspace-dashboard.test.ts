import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { workspaceDashboard } from '../src/core/workspace-dashboard.js';

/**
 * THE WORKSPACE DASHBOARD — the workspace's first tab (the owner, 2026-10-19: "get rid of the fucking Agents in the
 * workspace. That should be a Workspace dashboard showing all work being done by any running agents, not some lame agent
 * list with file changes"; the design approved in q_09d1f4a0, "build that"):
 *
 *   - a card per agent of THIS workspace that is running or waiting: what it was asked, the tool it is in now, its plan
 *     step, how long it has been working;
 *   - above the cards: what waits on YOU in this workspace (questions, approvals);
 *   - below: the last finished turns with their handoffs;
 *   - no file-change lists; a card opens its agent.
 */

const base: AgentRow = {
    id: 'a', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working',
    duration: '12m', ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};
const row = (over: Partial<AgentRow>): AgentRow => ({ ...base, ...over });
const item = (over: Partial<DeckItem>): DeckItem => ({
    id: 'q1', source: 'agent-question', agentId: 'a', agentName: 'kai', workspaceId: 'tynn', title: 'Merge #990?', blocking: true,
    priority: 'normal', at: 1, answer: { kind: 'form', fields: 1 }, forwardedFrom: null, ...over,
});
const NOW = 10 * 60 * 60_000;

describe('the cards — work in flight', () => {
    it("one per running or waiting agent of THIS workspace, waiting first; idle agents and other workspaces' are not cards (COUNTED)", () => {
        const view = workspaceDashboard({
            rows: [
                row({ id: 'w1', state: 'working' }),
                row({ id: 'idle', state: 'idle' }),
                row({ id: 'q', state: 'waiting', ask: 'Merge?' }),
                row({ id: 'other', workspaceId: 'fancy', state: 'working' }),
            ],
            workspaceId: 'tynn', deckItems: [], now: NOW,
        });
        expect(view.cards.map((c) => c.id)).toEqual(['q', 'w1']);
    });

    it('a card carries what it was asked, the tool it is in, its plan step and what the step is, and how long', () => {
        const [card] = workspaceDashboard({
            rows: [row({ id: 'w', asked: 'Build the dashboard', tool: 'npm test', step: '3/7', target: 'Write the tests', duration: '14m' })],
            workspaceId: 'tynn', deckItems: [], now: NOW,
        }).cards;
        expect(card).toMatchObject({ id: 'w', name: 'kai', asked: 'Build the dashboard', tool: 'npm test', step: '3/7', doing: 'Write the tests', duration: '14m', word: 'Working' });
    });

    it('what was not reported is null — never a dash, never "0m"', () => {
        const [card] = workspaceDashboard({ rows: [row({ id: 'w', duration: null })], workspaceId: 'tynn', deckItems: [], now: NOW }).cards;
        expect(card).toMatchObject({ asked: null, tool: null, step: null, doing: null, duration: null });
    });

    it('a waiting card says what it asks, and is not claimed to be in a tool', () => {
        const [card] = workspaceDashboard({ rows: [row({ id: 'q', state: 'waiting', ask: 'Merge?', tool: 'Bash' })], workspaceId: 'tynn', deckItems: [], now: NOW }).cards;
        expect(card).toMatchObject({ ask: 'Merge?', tool: null, word: 'Waiting on you' });
    });

    it('no agents at all, and agents with nothing running, are different sentences', () => {
        expect(workspaceDashboard({ rows: [], workspaceId: 'tynn', deckItems: [], now: NOW })).toMatchObject({ noAgents: true, quiet: false });
        expect(workspaceDashboard({ rows: [row({ state: 'idle' })], workspaceId: 'tynn', deckItems: [], now: NOW })).toMatchObject({ noAgents: false, quiet: true });
        expect(workspaceDashboard({ rows: [row({})], workspaceId: 'tynn', deckItems: [], now: NOW })).toMatchObject({ noAgents: false, quiet: false });
    });
});

describe('waiting on you — above the cards', () => {
    it("this workspace's questions and approvals; not another workspace's, not a stale one, not a finished agent's handoff (COUNTED)", () => {
        const view = workspaceDashboard({
            rows: [],
            workspaceId: 'tynn',
            deckItems: [
                item({ id: 'q1', title: 'Merge #990?' }),
                item({ id: 'approval:a', answer: { kind: 'inline', options: [] }, title: 'Run rm?' }),
                item({ id: 'elsewhere', workspaceId: 'fancy' }),
                item({ id: 'stale', stale: 'agent-gone' }),
                item({ id: 'done', source: 'finished-handoff', blocking: false }),
            ],
            now: NOW,
        });
        expect(view.waiting.map((w) => w.id)).toEqual(['q1', 'approval:a']);
        expect(view.waiting[0]).toMatchObject({ title: 'Merge #990?', agentName: 'kai' });
    });
});

describe('the last finished turns, with their handoffs — below', () => {
    it("each agent's latest handoff, newest first, with its age; an agent with none is not listed", () => {
        const view = workspaceDashboard({
            rows: [
                row({ id: 'old', name: 'wren', state: 'idle', handoff: { text: 'Settings merged.', at: NOW - 3 * 60 * 60_000 } }),
                row({ id: 'new', name: 'atlas', state: 'idle', handoff: { text: 'Drawer merged.', at: NOW - 5 * 60_000 } }),
                row({ id: 'none', state: 'idle' }),
                row({ id: 'away', workspaceId: 'fancy', state: 'idle', handoff: { text: 'x', at: NOW } }),
            ],
            workspaceId: 'tynn', deckItems: [], now: NOW,
        });
        expect(view.handoffs).toEqual([
            { agentId: 'new', name: 'atlas', text: 'Drawer merged.', age: '5m' },
            { agentId: 'old', name: 'wren', text: 'Settings merged.', age: '3h' },
        ]);
    });

    it('at most five', () => {
        const rows = Array.from({ length: 8 }, (_, i) => row({ id: `a${i}`, state: 'idle', handoff: { text: `h${i}`, at: NOW - i * 60_000 } }));
        expect(workspaceDashboard({ rows, workspaceId: 'tynn', deckItems: [], now: NOW }).handoffs.map((h) => h.agentId)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    });
});
