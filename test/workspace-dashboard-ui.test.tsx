import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActivityFeed } from '../src/core/activity-feed.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * SELECTING A WORKSPACE OPENS ITS DASHBOARD — A LANE PER AGENT (beta.33 item 10; the owner, 2026-10-20: "this workspace
 * dashboard is useless. Each agent should have a full lane that shows me a heartbeat of activity. Not some stupid card
 * that contains my msg … THINK BETTER"; ROWS, q_99659edf). Every agent of the workspace gets a full-width lane, stopped
 * ones too: state and how long, a heartbeat, PLAN, NOW and its own waiting-on-you on the left, its live feed on the right.
 * The lane REPLACES the cards, the "Waiting on you" band and "Last finished" this file pinned before (q_09d1f4a0) — the
 * old contract is rewritten here, not loosened. Terminals and Settings stay the other views of the same route.
 */
const base: AgentRow = {
    id: 'a', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working',
    duration: '12m', ask: null, reason: null, fixes: [], step: '3/7', target: 'Write the tests', activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};
const row = (over: Partial<AgentRow>): AgentRow => ({ ...base, ...over });
const rows = [
    row({ id: 'a1', name: 'kai', asked: 'Build the workspace dashboard', tool: 'npm test' }),
    row({ id: 'a2', name: 'wren', state: 'waiting', ask: 'Merge?' }),
    row({ id: 'a3', name: 'atlas', state: 'idle', handoff: { text: 'Drawer merged.', at: Date.now() - 5 * 60_000 } }),
    row({ id: 'elsewhere', workspaceId: 'fancy' }),
];
const deckItems: DeckItem[] = [
    { id: 'q1', source: 'agent-question', agentId: 'a2', agentName: 'wren', workspaceId: 'tynn', title: 'Merge #990 now?', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 1 }, forwardedFrom: null },
    { id: 'q2', source: 'agent-question', agentId: 'x', agentName: 'x', workspaceId: 'fancy', title: 'Not ours', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 1 }, forwardedFrom: null },
];
const T = Date.now();
const MIN = 60_000;
/** The host's pushed feeds (core/activity-feed.ts): a1 at work, a3 stopped two hours ago; a2's has not arrived. */
const feeds: Record<string, ActivityFeed> = {
    a1: { agentId: 'a1', running: true, since: T - 14 * MIN, lastAt: T - MIN, plan: { step: 2, of: 5, doing: 'Write the tests' }, beats: [{ minute: Math.floor(T / MIN), n: 3 }], items: [
        { id: 'r2', at: T - MIN, kind: 'finished', text: 'Turn 4 finished', by: null, plus: null, minus: null, status: null },
        { id: 'r1', at: T - 3 * MIN, kind: 'edit', text: 'src/a.ts', by: null, plus: 2, minus: 1, status: null },
    ] },
    a3: { agentId: 'a3', running: false, since: T - 125 * MIN, lastAt: T - 125 * MIN, plan: null, beats: [], items: [] },
};
const workspace = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const ops: WorkspaceOpsProps = {
    asleep: false, agentCount: 2, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    governs: { children: [], candidates: [{ id: 'fancy' }], onSet: () => {} },
    settings: { values: {}, overridden: [], onSet: () => {}, onReset: () => {} },
};
const render = (props: Partial<Parameters<typeof Workspace>[0]> = {}) =>
    renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} rows={rows} deckItems={deckItems} feeds={feeds} ops={ops} {...props} />);
const count = (html: string, attr: string) => (html.match(new RegExp(`${attr}="`, 'g')) ?? []).length;

describe('the workspace route opens on its dashboard', () => {
    it('a LANE per agent of THIS workspace — idle and stopped ones too (COUNTED); the old cards and bands are gone', () => {
        const html = render({ view: 'home' });
        expect(html).toContain('data-workspace-dashboard="tynn"');
        expect(count(html, 'data-dash-lane')).toBe(3);
        for (const id of ['a1', 'a2', 'a3']) expect(html).toContain(`data-dash-lane="${id}"`);
        expect(html).not.toContain('data-dash-lane="elsewhere"');
        expect(html).not.toContain('data-dash-card');
        expect(html).not.toContain('data-dash-handoff');
        expect(html).not.toContain('Last finished');
    });

    const lane = (html: string, id: string): string => {
        const start = html.indexOf(`data-dash-lane="${id}"`);
        const next = html.indexOf('data-dash-lane="', start + 1);
        return html.slice(start, next < 0 ? undefined : next);
    };

    it('the left of a lane: state and how long, the heartbeat, PLAN and NOW; the feed runs to its right', () => {
        const html = render({ view: 'home' });
        const a1 = lane(html, 'a1');
        expect(a1).toContain('Working');
        expect(a1).toContain('14m');
        expect(a1).toContain('data-lane-heartbeat');
        expect(a1).toContain('data-react-fancy-chart-sparkline');
        expect(a1).toMatch(/data-lane-plan[^>]*>[\s\S]*2\/5[\s\S]*Write the tests/);
        expect(a1).toMatch(/data-lane-now[^>]*>[\s\S]*npm test/);
        // The feed, newest first, AFTER the left column.
        expect(a1.indexOf('data-lane-feed')).toBeGreaterThan(a1.indexOf('data-lane-now'));
        expect(count(a1, 'data-feed-item')).toBe(2);
        expect(a1.indexOf('Turn 4 finished')).toBeLessThan(a1.indexOf('src/a.ts'));
        expect(a1).toContain('+2');
    });

    it("its OWN waiting-on-you, with Open, in the lane of the agent that asks (and not in another's)", () => {
        const html = render({ view: 'home' });
        expect(lane(html, 'a2')).toContain('data-lane-waiting="q1"');
        expect(lane(html, 'a2')).toContain('Merge #990 now?');
        expect(lane(html, 'a1')).not.toContain('data-lane-waiting');
        expect(html).not.toContain('Not ours');
    });

    it('a stopped agent: Stopped, its last activity, and Start', () => {
        // Start is offered where a window can start an agent (Shell passes onStartAgent); a Start that does nothing is not.
        const html = render({ view: 'home', onStartAgent: () => {} });
        const a3 = lane(html, 'a3');
        expect(a3).toContain('Stopped');
        expect(a3).toContain('2h 5m');
        expect(a3).toContain('data-lane-start="a3"');
        // CONTROL: a running agent is not offered Start.
        expect(lane(html, 'a1')).not.toContain('data-lane-start');
    });

    it('a workspace with no agents says so and offers + Add agent', () => {
        const none = render({ view: 'home', rows: [row({ workspaceId: 'fancy' })], deckItems: [] });
        expect(none).toContain('No agents in Tynn.ai.');
        expect(none).toContain('data-add-agent="tynn"');
        expect(count(none, 'data-dash-lane')).toBe(0);
        // CONTROL: with agents, no such sentence.
        expect(render({ view: 'home' })).not.toContain('No agents in Tynn.ai.');
    });

    it('no file-change list and no "Agents in" rail — the old home is gone', () => {
        const html = render({ view: 'home', files: NO_FILES });
        expect(html).not.toContain('data-home-changes');
        expect(html).not.toContain('Changes this session');
        expect(html).not.toContain('Agents in Tynn.ai');
        expect(html).not.toContain('data-workspace-home');
    });

    it('home is the DEFAULT: a Workspace with no view asked for shows the dashboard', () => {
        const html = render();
        expect(html).toContain('data-workspace-dashboard="tynn"');
        expect(html).not.toContain('data-workspace-settings');
    });

    it('the header carries the agents strip and the view tabs (Dashboard … Settings) with the current one marked', () => {
        const html = render({ view: 'home' });
        expect(count(html, 'data-agent-pill')).toBe(3);
        expect(html).toMatch(/data-workspace-tab="home"[^>]*data-current="true"[^>]*>Dashboard</);
        expect(html).not.toContain('data-workspace-tab="terminals"');
        expect(html).toContain('data-workspace-tab="add"');
        expect(html).toMatch(/data-workspace-tab="settings"(?![^>]*data-current)/);
    });

    it('settings: the governs and settings sections, and nothing of the dashboard or the terminals', () => {
        const html = render({ view: 'settings' });
        expect(html).toContain('data-workspace-settings');
        expect(html).toContain('data-governs');
        expect(html).toMatch(/data-workspace-tab="settings"[^>]*data-current="true"/);
        expect(html).not.toContain('data-workspace-dashboard');
        expect(html).not.toContain('data-terminal-add');
    });

    it('terminals (?view=terminals, kept for old links): the strip and the pane, and nothing of the dashboard or the settings', () => {
        const html = render({ view: 'terminals' });
        expect(html).toContain('data-terminal-tabs');
        expect(html).toContain('data-terminal-add');
        expect(html).not.toContain('data-workspace-dashboard');
        expect(html).not.toContain('data-workspace-settings');
    });

    it('?panel=files is the Files TAB — the files take the body, the dashboard is not drawn beside them (beta.35 #41) — and the bring-back bar when popped out', () => {
        const inline = render({ view: 'home', files: NO_FILES, panel: 'files' });
        expect(inline).toContain('data-files-panel="tynn"');
        expect(inline).not.toContain('data-workspace-dashboard="tynn"');
        const popped = render({ view: 'home', files: NO_FILES, panel: 'files', filesPopped: true, onBringBackFiles: () => {} });
        expect(popped).toContain('data-files-popped="tynn"');
        expect(popped).not.toContain('data-files-panel="tynn"');
        expect(render({ view: 'home', files: NO_FILES, panel: null })).not.toContain('data-files-panel="tynn"');
    });
});
