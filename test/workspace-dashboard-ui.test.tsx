import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * SELECTING A WORKSPACE OPENS ITS DASHBOARD (the owner, 2026-10-19: "get rid of the fucking Agents in the workspace. That
 * should be a Workspace dashboard showing all work being done by any running agents, not some lame agent list with file
 * changes"; the design approved in q_09d1f4a0). The first tab is the dashboard: what waits on you in this workspace, a
 * card per running or waiting agent (asked · tool · plan step · time), then the last finished turns with their handoffs.
 * No file-change list. Terminals and Settings stay the other views of the same route, reached by a labelled tab.
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
const workspace = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const ops: WorkspaceOpsProps = {
    asleep: false, agentCount: 2, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    governs: { children: [], candidates: [{ id: 'fancy' }], onSet: () => {} },
    settings: { values: {}, overridden: [], onSet: () => {}, onReset: () => {} },
};
const render = (props: Partial<Parameters<typeof Workspace>[0]> = {}) =>
    renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} rows={rows} deckItems={deckItems} ops={ops} {...props} />);
const count = (html: string, attr: string) => (html.match(new RegExp(`${attr}="`, 'g')) ?? []).length;

describe('the workspace route opens on its dashboard', () => {
    it('a card per running or waiting agent OF THIS WORKSPACE (COUNTED); the idle one is not a card', () => {
        const html = render({ view: 'home' });
        expect(html).toContain('data-workspace-dashboard="tynn"');
        expect(count(html, 'data-dash-card')).toBe(2);
        expect(html).toContain('data-dash-card="a1"');
        expect(html).toContain('data-dash-card="a2"');
        expect(html).not.toContain('data-dash-card="a3"');
        expect(html).not.toContain('data-dash-card="elsewhere"');
    });

    it('a card says what it was asked, the tool it is in, its plan step, and how long', () => {
        const html = render({ view: 'home' });
        const card = html.slice(html.indexOf('data-dash-card="a1"'), html.indexOf('data-dash-card="a2"') > html.indexOf('data-dash-card="a1"') ? html.indexOf('data-dash-card="a2"') : undefined);
        expect(card).toContain('Build the workspace dashboard');
        expect(card).toContain('npm test');
        expect(card).toContain('3/7');
        expect(card).toContain('Write the tests');
        expect(card).toContain('12m');
    });

    it('above the cards: what waits on you in THIS workspace (COUNTED), and it comes before the first card', () => {
        const html = render({ view: 'home' });
        expect(count(html, 'data-dash-waiting')).toBe(1);
        expect(html).toContain('data-dash-waiting="q1"');
        expect(html).toContain('Merge #990 now?');
        expect(html.indexOf('data-dash-waiting="q1"')).toBeLessThan(html.indexOf('data-dash-card='));
    });

    it('below the cards: the last finished turns with their handoffs', () => {
        const html = render({ view: 'home' });
        expect(html).toContain('data-dash-handoff="a3"');
        expect(html).toContain('Drawer merged.');
        expect(html.indexOf('data-dash-handoff="a3"')).toBeGreaterThan(html.indexOf('data-dash-card="a1"'));
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

    it('a workspace with no agents says so and offers + Add agent; one whose agents are all idle says nothing is running', () => {
        const none = render({ view: 'home', rows: [row({ workspaceId: 'fancy' })], deckItems: [] });
        expect(none).toContain('No agents in Tynn.ai.');
        expect(none).toContain('data-add-agent="tynn"');
        expect(count(none, 'data-dash-card')).toBe(0);
        const quiet = render({ view: 'home', rows: [row({ state: 'idle' })], deckItems: [] });
        expect(quiet).toContain('Nothing is running in Tynn.ai.');
        expect(quiet).not.toContain('data-add-agent=');
        // CONTROL: with agents at work neither sentence is said.
        const busy = render({ view: 'home' });
        expect(busy).not.toContain('No agents in Tynn.ai.');
        expect(busy).not.toContain('Nothing is running in Tynn.ai.');
    });

    it('keeps the one file panel beside the dashboard when ?panel=files, and the bring-back bar when it is popped out', () => {
        const inline = render({ view: 'home', files: NO_FILES, panel: 'files' });
        expect(inline).toContain('data-files-panel="tynn"');
        expect(inline).toContain('data-workspace-dashboard="tynn"');
        const popped = render({ view: 'home', files: NO_FILES, panel: 'files', filesPopped: true, onBringBackFiles: () => {} });
        expect(popped).toContain('data-files-popped="tynn"');
        expect(popped).not.toContain('data-files-panel="tynn"');
        expect(render({ view: 'home', files: NO_FILES, panel: null })).not.toContain('data-files-panel="tynn"');
    });
});
