// @vitest-environment happy-dom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statusOf, type AgentRow, type AgentState } from '../src/core/dashboard-view.js';
import type { RailItem } from '../src/core/rail-view.js';
import { FidelityDot } from '../src/renderer/components/Dashboard.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE SIDEBAR'S AGENT LIST (Tynn #687; the owner, 2026-11-13: "in the workspace sidebar, I want to have two views that can
 * be toggled, workspace list and the agent list. I need a way to quickly select agents without switching workspaces. The
 * workspace UI and buttons are not carried over to the agent list item UI (same sidebar style, but different content in
 * the menu item). The agent list shows provider icon, status (colored like the dashboard uses, no label), a button to open
 * the workspace, agent settings and shell count.").
 *
 * Interaction is a claim about a live DOM, so this commits the tree in happy-dom (docs/decisions.md D4); the status colour
 * is compared against the Dashboard's own rendered dot, state by state.
 */
const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null,
    reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
    commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});
const ws = (id: string, over: Partial<RailItem> = {}): RailItem => ({
    id, path: `/w/${id}`, name: id, count: 1, alert: null, processes: 'running', processesTitle: '1 process', sites: 'running', sitesTitle: '1 site', working: 1, color: 'teal', ...over,
});
const WORKSPACES: RailItem[] = [ws('tynn'), ws('fancy'), ws('zz', { asleep: true, count: null })];
const AGENTS: AgentRow[] = [
    row({ id: 'a_atlas', name: 'atlas', state: 'working', background: 3 }),
    row({ id: 'a_wren', name: 'wren', provider: 'codex', state: 'cooling' }),
    row({ id: 'a_kai', name: 'kai', workspaceId: 'fancy', state: 'waiting', ask: 'Ship it?' }),
    // In a HIBERNATED workspace: a ghost, never listed outside the sidebar's hibernated view (the owner's rule).
    row({ id: 'a_ghost', name: 'ghost', workspaceId: 'zz', state: 'idle' }),
    // The OS agent belongs to no workspace: it has its own System button, it is not a workspace's agent.
    row({ id: 'a_genie', name: 'genie', workspaceId: '__genie__', state: 'idle' }),
];
const memory = (seed: Record<string, string> = {}) => {
    const data = new Map(Object.entries(seed));
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
};

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
let navigated: string[];
let chatted: string[];
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    navigated = [];
    chatted = [];
    window.localStorage.clear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
});
type Storage_ = ReturnType<typeof memory>;
const draw = (storage: Storage_, over: { agents?: AgentRow[]; route?: string; collapsed?: boolean } = {}) => {
    if (over.collapsed) storage.data.set('genie.rail.collapsed', '1');
    act(() => root.render(
        <Sidebar
            route={over.route ?? 'genie://workspace/tynn'} deckCount={0} workspaces={WORKSPACES}
            available={['deck', 'dashboard', 'genie', 'workspace', 'settings']}
            onNavigate={(r) => navigated.push(r)} onWakeWorkspace={() => {}} onAddWorkspace={() => {}}
            onOpenProcesses={() => {}} onOpenSites={() => {}} railStorage={storage} currentWorkspaceId="tynn"
            agents={over.agents ?? AGENTS} onChatAgent={(id) => chatted.push(id)}
        />,
    ));
};
const $ = (sel: string) => host.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const click = (el: Element | null) => {
    if (!el) throw new Error('nothing to click');
    act(() => { (el as HTMLElement).click(); });
};
const toAgents = () => click($('[data-rail-view="agents"]'));
const agentRow = (id: string) => $(`[data-rail-agent="${id}"]`);
/** The agent row's whole unit: its item and the buttons beside it. */
const agentUnit = (id: string) => agentRow(id)?.closest<HTMLElement>('[data-rail-agent-unit]') ?? null;

describe('the toggle', () => {
    it('is at the top of the rail: two icon buttons, Workspaces and Agents, named but wordless; Workspaces is the default', () => {
        draw(memory());
        const tools = $('[data-rail-tools]');
        const workspaces = tools?.querySelector<HTMLElement>('[data-rail-view="workspaces"]');
        const agents = tools?.querySelector<HTMLElement>('[data-rail-view="agents"]');
        expect(workspaces?.tagName).toBe('BUTTON');
        expect(agents?.tagName).toBe('BUTTON');
        expect(workspaces?.getAttribute('aria-label')).toBe('Workspaces');
        expect(agents?.getAttribute('aria-label')).toBe('Agents');
        expect(workspaces?.getAttribute('title')).toBe('Workspaces');
        expect(agents?.getAttribute('title')).toBe('Agents');
        // Icons, not words.
        expect(workspaces?.textContent?.trim()).toBe('');
        expect(agents?.textContent?.trim()).toBe('');
        expect(workspaces?.querySelector('svg, [data-icon], span')).not.toBeNull();
        expect(workspaces?.getAttribute('aria-pressed')).toBe('true');
        expect(agents?.getAttribute('aria-pressed')).toBe('false');
        // The workspace list is drawn, and no agent row.
        expect($$('[data-workspace]').length).toBeGreaterThan(0);
        expect($$('[data-rail-agent]')).toHaveLength(0);
    });

    it('switches to the agent list and back', () => {
        draw(memory());
        toAgents();
        expect($('[data-rail-view="agents"]')?.getAttribute('aria-pressed')).toBe('true');
        expect($('[data-rail-view="workspaces"]')?.getAttribute('aria-pressed')).toBe('false');
        expect($$('[data-rail-agent]').map((el) => el.dataset['railAgent']).sort()).toEqual(['a_atlas', 'a_kai', 'a_wren']);
        expect($$('[data-workspace]')).toHaveLength(0);
        click($('[data-rail-view="workspaces"]'));
        expect($$('[data-rail-agent]')).toHaveLength(0);
        expect($$('[data-workspace]').length).toBeGreaterThan(0);
    });

    it('is remembered on this device, where the rail keeps its other preferences (control: a fresh device shows Workspaces)', () => {
        const storage = memory();
        draw(storage);
        toAgents();
        expect(storage.data.get('genie.rail.view')).toBe('agents');
        act(() => root.unmount());
        root = createRoot(host);
        draw(storage);
        expect($('[data-rail-view="agents"]')?.getAttribute('aria-pressed')).toBe('true');
        expect($$('[data-rail-agent]').length).toBe(3);
        act(() => root.unmount());
        root = createRoot(host);
        draw(memory());
        expect($$('[data-rail-agent]')).toHaveLength(0);
    });

    it('is there when the rail is collapsed too, and the agent list draws there', () => {
        draw(memory({ 'genie.rail.view': 'agents' }), { collapsed: true });
        expect($('[data-rail="collapsed"] [data-rail-view="agents"]')?.getAttribute('aria-pressed')).toBe('true');
        expect($$('[data-rail-agent]').map((el) => el.dataset['railAgent']).sort()).toEqual(['a_atlas', 'a_kai', 'a_wren']);
        expect(agentRow('a_atlas')?.querySelector('[data-provider-logo="claude"]')).not.toBeNull();
        expect(agentRow('a_atlas')?.querySelector('[data-agent-status]')).not.toBeNull();
    });
});

describe('an agent row', () => {
    it('has the provider logo, the name, a status dot with no word, the shell count, and two icon buttons: open its workspace, its settings', () => {
        draw(memory({ 'genie.rail.view': 'agents' }));
        const item = agentRow('a_atlas')!;
        expect(item.tagName).toBe('BUTTON');
        expect(item.querySelector('[data-provider-logo="claude"]')).not.toBeNull();
        expect(agentRow('a_wren')!.querySelector('[data-provider-logo="codex"]')).not.toBeNull();
        expect(item.textContent).toContain('atlas');
        const dot = item.querySelector<HTMLElement>('[data-agent-status]')!;
        expect(dot).not.toBeNull();
        expect(dot.textContent).toBe('');
        expect(dot.getAttribute('aria-label')).toBe('Working');
        expect(dot.getAttribute('title')).toBe('Working');
        // No status WORD anywhere in the row (the owner: "no label").
        expect(item.textContent).not.toMatch(/Working|Cooling|Waiting/);
        expect(item.querySelector('[data-agent-shells]')?.getAttribute('data-agent-shells')).toBe('3');
        expect(item.querySelector('[data-agent-shells]')?.textContent).toContain('3');

        const unit = agentUnit('a_atlas')!;
        const open = unit.querySelector<HTMLElement>('[data-agent-open-workspace]')!;
        const settings = unit.querySelector<HTMLElement>('[data-agent-settings]')!;
        for (const b of [open, settings]) {
            expect(b.tagName).toBe('BUTTON');
            // A real button BESIDE the row, never nested inside its button.
            expect(item.contains(b)).toBe(false);
            expect(b.textContent?.trim()).toBe('');
        }
        expect(open.getAttribute('data-agent-open-workspace')).toBe('tynn');
        expect(open.getAttribute('aria-label')).toBe('Open workspace tynn');
        expect(settings.getAttribute('aria-label')).toBe('atlas settings');
    });

    it('a shell count that was never reported draws nothing (a 0 would be a claim)', () => {
        draw(memory({ 'genie.rail.view': 'agents' }));
        expect(agentRow('a_wren')!.querySelector('[data-agent-shells]')).toBeNull();
        expect(agentRow('a_atlas')!.querySelector('[data-agent-shells]')).not.toBeNull();
    });

    it('carries NONE of the workspace row’s controls (control: the workspace view has them)', () => {
        const storage = memory();
        draw(storage);
        const workspaceControls = ['[data-ws-processes]', '[data-ws-sites]', '[data-pulse]', '[data-workspace-color]', '[data-workspace]', '[data-rail-tool="hibernated"]', '[data-rail-tool="add-workspace"]'];
        for (const sel of workspaceControls) expect($(sel), `control: ${sel} in the workspace view`).not.toBeNull();
        toAgents();
        for (const sel of workspaceControls) expect($(sel), sel).toBeNull();
        expect(host.querySelector('[aria-label="Filter workspaces"]')).toBeNull();
    });

    it('lists no agent of a hibernated workspace, even with hibernated workspaces shown; nor the OS agent', () => {
        window.localStorage.setItem('genie.rail.showHibernated', '1');
        draw(memory({ 'genie.rail.view': 'workspaces' }));
        // CONTROL: the hibernated workspace IS shown in the workspace view.
        expect($('[data-workspace="zz"]')).not.toBeNull();
        toAgents();
        expect(agentRow('a_ghost')).toBeNull();
        expect(agentRow('a_genie')).toBeNull();
        expect(host.textContent).not.toContain('ghost');
        expect(agentRow('a_kai')).not.toBeNull();
    });
});

describe('the status dot is the Dashboard’s colour for every state', () => {
    const dashboardColour = (state: AgentState): string => {
        const html = renderToStaticMarkup(<FidelityDot fidelity="declared" state={state} />);
        const m = html.match(/--agent-status:\s*([^;"]+)/);
        if (!m) throw new Error(`the Dashboard's dot carries no colour for ${state}`);
        return m[1]!.trim();
    };
    const STATES: AgentState[] = ['working', 'cooling', 'waiting', 'broken', 'idle', 'sleeping', 'stopped', 'remote'];

    it.each(STATES)('%s', (state) => {
        const agent = row({ id: `a_${state}`, name: state, state, ...(state === 'remote' ? { fidelity: 'remote' as const } : {}) });
        draw(memory({ 'genie.rail.view': 'agents' }), { agents: [agent] });
        const dot = agentRow(agent.id)!.querySelector<HTMLElement>('[data-agent-status]')!;
        expect(dot.getAttribute('data-agent-status')).toBe(state);
        expect(dot.style.getPropertyValue('--agent-status').trim()).toBe(dashboardColour(state));
        expect(dot.getAttribute('aria-label')).toBe(statusOf(agent).word);
    });

    it('CONTROL: the gauge tells states apart — Cooling is not Working’s colour, nor Idle’s', () => {
        expect(dashboardColour('cooling')).not.toBe(dashboardColour('working'));
        expect(dashboardColour('cooling')).not.toBe(dashboardColour('idle'));
    });

    it('an idle agent with background shells reads Working, as on the Dashboard', () => {
        const agent = row({ id: 'a_bg', name: 'bg', state: 'idle', background: 2 });
        draw(memory({ 'genie.rail.view': 'agents' }), { agents: [agent] });
        const dot = agentRow('a_bg')!.querySelector<HTMLElement>('[data-agent-status]')!;
        expect(dot.getAttribute('data-agent-status')).toBe('working');
        expect(dot.style.getPropertyValue('--agent-status').trim()).toBe(dashboardColour('working'));
        expect(agentRow('a_bg')!.querySelector('[data-agent-shells]')?.getAttribute('data-agent-shells')).toBe('2');
    });
});

describe('clicking', () => {
    it('a row opens that agent’s chat and navigates nowhere — the workspace on screen stays', () => {
        draw(memory({ 'genie.rail.view': 'agents' }));
        click(agentRow('a_kai'));
        expect(chatted).toEqual(['a_kai']);
        expect(navigated).toEqual([]);
    });

    it('its open-workspace button opens ITS workspace, and does not touch the chat', () => {
        draw(memory({ 'genie.rail.view': 'agents' }));
        click(agentUnit('a_kai')!.querySelector('[data-agent-open-workspace]'));
        expect(navigated).toEqual(['genie://workspace/fancy']);
        expect(chatted).toEqual([]);
    });

    it('its settings button opens the agent’s Settings tab', () => {
        draw(memory({ 'genie.rail.view': 'agents' }));
        click(agentUnit('a_wren')!.querySelector('[data-agent-settings]'));
        expect(navigated).toEqual(['genie://agent/a_wren?tab=settings']);
        expect(chatted).toEqual([]);
    });

    it('on an agent’s page, that agent’s row is the active one, and only it', () => {
        draw(memory({ 'genie.rail.view': 'agents' }), { route: 'genie://agent/a_atlas?tab=stream' });
        expect(agentRow('a_atlas')?.getAttribute('data-active')).toBe('true');
        expect(agentRow('a_kai')?.getAttribute('data-active')).not.toBe('true');
    });
});
