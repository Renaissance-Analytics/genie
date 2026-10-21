import { describe, expect, it } from 'vitest';
import type { ActivityFeed } from '../src/core/activity-feed.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { workspaceDashboard } from '../src/core/workspace-dashboard.js';

/**
 * THE WORKSPACE DASHBOARD = A LANE PER AGENT (beta.33 item 10). The owner, 2026-10-20: "this workspace dashboard is
 * useless. Each agent should have a full lane that shows me a heartbeat of activity. Not some stupid card that contains
 * my msg … THINK BETTER." Asked rows or columns (q_99659edf), he chose ROWS: each lane full width, state / heartbeat /
 * plan / now on the left, the live feed running right.
 *
 * This REPLACES the contract the previous version of this file pinned (q_09d1f4a0, 2026-10-19): a card per RUNNING
 * agent only, a workspace "Waiting on you" band above, and "Last finished" below read from the last `imDone` handoff —
 * which never updated for an agent answering in chat. Now EVERY agent has a lane (stopped ones too), each carries its
 * own waiting-on-you, and finished is the session's real turn ends, in its feed.
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
const MIN = 60_000;
const NOW = 10 * 60 * MIN;
const feed = (agentId: string, over: Partial<ActivityFeed> = {}): ActivityFeed => ({
    agentId, running: true, since: NOW - 14 * MIN, lastAt: NOW - MIN, plan: null, beats: [], items: [], ...over,
});
const view = (rows: AgentRow[], over: { deckItems?: DeckItem[]; feeds?: Record<string, ActivityFeed> } = {}) =>
    workspaceDashboard({ rows, workspaceId: 'tynn', deckItems: over.deckItems ?? [], feeds: over.feeds ?? {}, now: NOW });

describe('a lane per agent — every agent of the workspace, stopped ones too', () => {
    it("one lane per agent of THIS workspace whatever its state, waiting first; another workspace's are not lanes (COUNTED)", () => {
        const v = view([
            row({ id: 'w1', state: 'working' }),
            row({ id: 'idle', state: 'idle' }),
            row({ id: 'q', state: 'waiting', ask: 'Merge?' }),
            row({ id: 'other', workspaceId: 'fancy' }),
        ]);
        expect(v.lanes.map((l) => l.id)).toEqual(['q', 'w1', 'idle']);
    });

    it('state, and how long it has been in it — from the feed (since its turn began), not since the session started', () => {
        const [lane] = view([row({ id: 'a', duration: '3h' })], { feeds: { a: feed('a', { since: NOW - 14 * MIN }) } }).lanes;
        expect(lane).toMatchObject({ word: 'Working', inState: '14m', stopped: false });
    });

    it('a stopped agent says so, with its last activity, and can be started', () => {
        const [lane] = view([row({ id: 'a', state: 'idle', duration: null })], { feeds: { a: feed('a', { running: false, since: NOW - 125 * MIN, lastAt: NOW - 125 * MIN }) } }).lanes;
        expect(lane).toMatchObject({ stopped: true, word: 'Stopped', lastActive: '2h 5m' });
    });

    it('until its feed arrives a lane claims nothing: no heartbeat, no feed, not "stopped"', () => {
        const [lane] = view([row({ id: 'a', state: 'idle' })]).lanes;
        expect(lane).toMatchObject({ heartbeat: null, feed: [], stopped: false, inState: null, lastActive: null });
    });

    it('no agents at all offers + Add agent', () => {
        expect(view([])).toMatchObject({ noAgents: true, lanes: [] });
        expect(view([row({ state: 'idle' })])).toMatchObject({ noAgents: false });
    });
});

describe('heartbeat, plan, now', () => {
    it('the heartbeat is 30 minutes of activity, oldest first, and its total', () => {
        const minute = Math.floor(NOW / MIN);
        const [lane] = view([row({ id: 'a' })], { feeds: { a: feed('a', { beats: [{ minute: minute - 2, n: 4 }, { minute, n: 1 }] }) } }).lanes;
        expect(lane!.heartbeat).toHaveLength(30);
        expect(lane!.heartbeat!.at(-1)).toBe(1);
        expect(lane!.heartbeat!.at(-3)).toBe(4);
        expect(lane!.beats).toBe(5);
    });

    it("PLAN is the session's latest plan (step of, and the current step) — for a stopped agent too, from its history", () => {
        const [lane] = view([row({ id: 'a', state: 'idle' })], { feeds: { a: feed('a', { running: false, plan: { step: 2, of: 5, doing: 'Write the tests' } }) } }).lanes;
        expect(lane!.plan).toEqual({ step: '2/5', doing: 'Write the tests' });
        // Before the feed lands, the session's own reading stands in.
        expect(view([row({ id: 'a', step: '3/7', target: 'Ship' })]).lanes[0]!.plan).toEqual({ step: '3/7', doing: 'Ship' });
    });

    it('NOW is the tool running this second — only while working, never for an agent waiting on you', () => {
        expect(view([row({ id: 'a', tool: 'npm test' })]).lanes[0]!.now).toBe('npm test');
        expect(view([row({ id: 'a', state: 'waiting', tool: 'npm test', ask: 'Run rm?' })]).lanes[0]!.now).toBeNull();
    });
});

describe('its own waiting-on-you', () => {
    it("each lane carries ITS questions and approvals (not another agent's, not a stale one), to open", () => {
        const v = view([row({ id: 'a', state: 'waiting', ask: 'Run rm?' }), row({ id: 'b', name: 'wren', state: 'idle' })], {
            deckItems: [
                item({ id: 'q1', agentId: 'a', title: 'Merge #990?' }),
                item({ id: 'approval:a', agentId: 'a', answer: { kind: 'inline', options: [] }, title: 'Run rm?' }),
                item({ id: 'qb', agentId: 'b', title: 'Which drawer?' }),
                item({ id: 'stale', agentId: 'a', stale: 'agent-gone' }),
                item({ id: 'done', agentId: 'a', source: 'finished-handoff', blocking: false }),
            ],
        });
        expect(v.lanes.find((l) => l.id === 'a')!.waiting.map((w) => w.id)).toEqual(['q1', 'approval:a']);
        expect(v.lanes.find((l) => l.id === 'b')!.waiting).toEqual([{ id: 'qb', title: 'Which drawer?' }]);
    });

    it('a question in this workspace that belongs to NO lane is still shown (it would otherwise have no way in)', () => {
        const v = view([row({ id: 'a' })], { deckItems: [item({ id: 'flow', agentId: null, agentName: null, title: 'Approve the deploy?' }), item({ id: 'x', workspaceId: 'fancy', agentId: null })] });
        expect(v.waiting.map((w) => w.id)).toEqual(['flow']);
    });
});

describe('the live feed', () => {
    it('its real session events, newest first, each with its age; a filed handoff joins them at its time', () => {
        const [lane] = view([row({ id: 'a', state: 'idle', handoff: { text: 'Drawer merged.', at: NOW - 5 * MIN } })], {
            feeds: { a: feed('a', { items: [
                { id: 'r3', at: NOW - 1 * MIN, kind: 'finished', text: 'Turn 4 finished', by: null, plus: null, minus: null, status: null },
                { id: 'r2', at: NOW - 9 * MIN, kind: 'edit', text: 'src/a.ts', by: null, plus: 2, minus: 1, status: null },
            ] }) },
        }).lanes;
        expect(lane!.feed.map((f) => [f.kind, f.text, f.age])).toEqual([
            ['finished', 'Turn 4 finished', '1m'],
            ['handoff', 'Drawer merged.', '5m'],
            ['edit', 'src/a.ts', '9m'],
        ]);
    });
});
