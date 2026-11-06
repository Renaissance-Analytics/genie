import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { groupByStatus, statusOf, summaryChips, type AgentRow } from '../src/core/dashboard-view.js';
import { workingAgents } from '../src/core/rail-indicators.js';
import { railWorkspaces } from '../src/core/rail-view.js';
import { workspaceDashboard } from '../src/core/workspace-dashboard.js';
import { agentTabsOf } from '../src/core/workspace-tabs.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * "AN AGENT THAT IS WORKING IN THE BACKGROUND IS NOT AN IDLE AGENT" (the owner, genie#1528): a grey dot beside a green
 * "Working" contradicts it. Every dot and the rail's pulse show these agents as working, by the rule the board's groups
 * and counts use. `row.state` stays what it is (test/background-not-idle.test.ts), and the alert and `now` are not moved.
 */

const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'a', name: 'atlas', provider: 'claude', workspaceId: 'ws', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});

const DOT: Record<AgentRow['state'], string> = {
    working: 'text-[var(--success)]', cooling: 'text-[var(--sky-400)]', waiting: 'text-[var(--warning)]', broken: 'text-[var(--danger)]', idle: 'text-[var(--zinc-400)]', remote: 'text-[var(--fg-4)]',
};

/** Each row, and the state its dots show. The same table goes through every surface below. */
const CASES: ReadonlyArray<readonly [string, AgentRow, AgentRow['state']]> = [
    ['idle, with background work', row({ background: 5 }), 'working'],
    ['Cooling, with background work: it reads Working, so its dot does', row({ state: 'cooling', background: 2 }), 'working'],
    ['CONTROL: idle, a count of 0', row({ background: 0 }), 'idle'],
    ['CONTROL: idle, no count', row({ background: null }), 'idle'],
    ['CONTROL: Cooling keeps its own colour', row({ state: 'cooling' }), 'cooling'],
    ['CONTROL: working', row({ state: 'working' }), 'working'],
    ['CONTROL: waiting comes first', row({ state: 'waiting', ask: 'Run it?', background: 2 }), 'waiting'],
    ['CONTROL: broken comes first', row({ state: 'broken', reason: 'gone', background: 2 }), 'broken'],
    ['CONTROL: an observed row is only bytes', row({ fidelity: 'observed', background: 3 }), 'idle'],
];

const lanes = (r: AgentRow) => workspaceDashboard({ rows: [r], workspaceId: 'ws', deckItems: [], feeds: {}, now: 1 });

describe.each(CASES)('%s', (_name, r, shown) => {
    it('the Dashboard row’s dot', () => {
        const html = renderToStaticMarkup(<Dashboard rows={[r]} workspaces={[{ id: 'ws', name: 'WS', path: '/w/ws' }]} onOpenAgent={() => {}} onAddAgent={() => {}} />);
        const dot = /data-agent="a"[^]*?data-fidelity="\w+" class="([^"]*)"/.exec(html);
        expect(dot?.[1]).toContain(DOT[shown]);
    });

    it('the workspace dashboard’s lane dot, and the strip’s (Workspace.tsx)', () => {
        const view = lanes(r);
        expect(view.lanes[0]!.state).toBe(shown);
        expect(view.strip[0]!.state).toBe(shown);
    });

    it('the workspace tab’s dot and its tooltip', () => {
        const html = renderToStaticMarkup(
            <WorkspaceTabs designed={{ tabs: [] }} agents={agentTabsOf([r], 'ws')} current={{ kind: 'view', view: 'home' }} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} />,
        );
        expect(html).toContain(`data-agent-state="${shown}"`);
        expect(html).toContain(`title="atlas · ${shown}"`);
    });
});

describe('the rail’s pulse: what workspaces have working agents', () => {
    it('counts an agent working in the background, and through railWorkspaces', () => {
        expect(workingAgents([row({ background: 5 })], 'ws')).toBe(1);
        expect(railWorkspaces([{ id: 'ws', path: '/w/ws', agentsKnown: true }], [row({ background: 5 })])[0]).toMatchObject({ working: 1, alert: false });
    });

    it('CONTROL: counts what it counted, and no more (COUNTED)', () => {
        const rows = [row({ state: 'working' }), row({ state: 'cooling' }), row({}), row({ background: 0 }), row({ fidelity: 'observed', background: 3 }), row({ state: 'waiting', background: 2 }), row({ state: 'broken', background: 2 }), row({ workspaceId: 'other', background: 5 })];
        expect(workingAgents(rows, 'ws')).toBe(2);
    });
});

describe('what is not moved', () => {
    it('`now` is the tool of a running turn: none, for an idle chat with background work', () => {
        expect(lanes(row({ tool: 'npm test', background: 5 })).lanes[0]!.now).toBeNull();
        // POSITIVE CONTROL: the same row, mid-turn, shows it.
        expect(lanes(row({ tool: 'npm test', state: 'working', background: 5 })).lanes[0]!.now).toBe('npm test');
    });
});

describe('Paused, Signed out or Login needed, with background work: its own word, in the Working group', () => {
    const HELD: ReadonlyArray<readonly [string, Partial<AgentRow>]> = [
        ['Paused', { limit: { state: 'needs-person', message: null } }],
        ['Signed out', { signedOut: true }],
        ['Login needed', { designLogin: true }],
    ];

    it.each(HELD)('%s', (word, over) => {
        const working = row({ ...over, background: 3 });
        expect(statusOf(working).word).toBe(word);
        expect(groupByStatus([working]).map((g) => g.label)).toEqual(['Working']);
        expect(summaryChips([working]).map((c) => c.label)).toEqual(['1 working']);

        // CONTROL, so the group above is the background work's doing: the same row with none, the same word, in Idle.
        const none = row({ ...over, background: 0 });
        expect(statusOf(none).word).toBe(word);
        expect(groupByStatus([none]).map((g) => g.label)).toEqual(['Idle']);
        expect(summaryChips([none]).map((c) => c.label)).toEqual(['1 idle']);

        // Its dot agrees with the group it sits in.
        expect(lanes(working).lanes[0]!.state).toBe('working');
        expect(lanes(none).lanes[0]!.state).toBe('idle');
    });
});
