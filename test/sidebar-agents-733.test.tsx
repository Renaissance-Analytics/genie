// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { RailItem } from '../src/core/rail-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE AGENTS SIDEBAR (Tynn #733): it follows the Dashboard's Sleeping / Stopped filter (one source of truth), the list scrolls
 * on its own, and the terminal and folder buttons open a window instead of navigating.
 */
const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null,
    reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
    commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});
const ws = (id: string): RailItem => ({
    id, path: `/w/${id}`, name: id, count: 1, alert: null, processes: 'running', processesTitle: '1 process', sites: 'running', sitesTitle: '1 site', working: 0, color: 'teal',
});
const AGENTS: AgentRow[] = [
    row({ id: 'a_idle', name: 'idle-one', state: 'idle' }),
    row({ id: 'a_sleep', name: 'sleepy', state: 'sleeping' }),
    row({ id: 'a_stop', name: 'stopped-one', state: 'stopped' }),
    row({ id: 'a_fancy', name: 'fancy-one', workspaceId: 'fancy', state: 'working', background: 2 }),
];
const memory = (seed: Record<string, string> = {}) => {
    const data = new Map(Object.entries({ 'genie.rail.view': 'agents', ...seed }));
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
};

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
let navigated: string[];
let terminals: string[];
let files: string[];
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    navigated = []; terminals = []; files = [];
    window.localStorage.clear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
});
const sidebar = (withOpeners = true) => (
    <Sidebar
        route="genie://dashboard" deckCount={0} workspaces={[ws('tynn'), ws('fancy')]}
        available={['deck', 'dashboard', 'genie', 'workspace', 'settings']}
        onNavigate={(r) => navigated.push(r)} railStorage={memory()} agents={AGENTS} onChatAgent={() => {}}
        {...(withOpeners ? { onOpenAgentTerminal: (id: string) => terminals.push(id), onOpenWorkspaceFiles: (id: string) => files.push(id) } : {})}
    />
);
const $ = (sel: string) => host.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const click = (el: Element | null) => { if (!el) throw new Error('nothing to click'); act(() => { (el as HTMLElement).click(); }); };
const listed = () => $$('[data-rail-agent]').map((el) => el.dataset['railAgent']).sort();

describe('the filter is the Dashboard’s', () => {
    it('hides Sleeping and Stopped agents by default, as the Dashboard does', () => {
        act(() => root.render(sidebar()));
        expect(listed()).toEqual(['a_fancy', 'a_idle']);
    });

    it('shows Sleeping agents when the Dashboard’s persisted filter says so, and Stopped the same way', () => {
        window.localStorage.setItem('genie.dashboard.show.sleeping', '1');
        act(() => root.render(sidebar()));
        expect(listed()).toEqual(['a_fancy', 'a_idle', 'a_sleep']);
        act(() => root.unmount());
        root = createRoot(host);
        window.localStorage.setItem('genie.dashboard.show.stopped', '1');
        act(() => root.render(sidebar()));
        expect(listed()).toEqual(['a_fancy', 'a_idle', 'a_sleep', 'a_stop']);
    });

    it('changing the filter on a mounted Dashboard updates a mounted sidebar at once', () => {
        act(() => root.render(
            <>
                {sidebar()}
                <Dashboard rows={AGENTS} workspaces={[ws('tynn'), ws('fancy')]} onOpenAgent={() => {}} onAddAgent={() => {}} />
            </>,
        ));
        expect(listed()).toEqual(['a_fancy', 'a_idle']);
        const toggle = $('[data-dashboard-filter="sleeping"]');
        expect(toggle, 'the Dashboard has a Sleeping toggle').toBeDefined();
        click(toggle ?? null);
        expect(window.localStorage.getItem('genie.dashboard.show.sleeping')).toBe('1');
        expect(listed()).toEqual(['a_fancy', 'a_idle', 'a_sleep']);
    });

    it('the text filter still narrows within that set', () => {
        window.localStorage.setItem('genie.dashboard.show.sleeping', '1');
        act(() => root.render(sidebar()));
        const input = $('[data-rail-filter]') as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(input, 'sleep'); input.dispatchEvent(new Event('input', { bubbles: true })); });
        expect(listed()).toEqual(['a_sleep']);
        act(() => { setter.call(input, 'stopped'); input.dispatchEvent(new Event('input', { bubbles: true })); });
        // Stopped is filtered out by the shared filter, so the text cannot bring it back.
        expect(listed()).toEqual([]);
    });
});

describe('the list scrolls', () => {
    it('is its own scroll container in a flex column, with the nav above it left fixed', () => {
        act(() => root.render(sidebar()));
        const rail = $('[data-rail="expanded"]')!;
        expect(rail.className).toMatch(/\bmin-h-0\b/);
        const scroller = $('[data-rail-list]')!;
        expect(scroller).not.toBeNull();
        expect(scroller.className).toMatch(/\boverflow-y-auto\b/);
        expect(scroller.className).toMatch(/\bmin-h-0\b/);
        expect(scroller.className).toMatch(/\bflex-1\b/);
        expect(scroller.querySelector('[data-rail-agent]')).not.toBeNull();
        // The nav rows are outside it.
        expect(scroller.querySelector('[data-nav="genie://dashboard"]')).toBeNull();
        expect($('[data-nav="genie://dashboard"]')).not.toBeNull();
    });

    it('the workspace list scrolls too (control: same container)', () => {
        act(() => root.render(<Sidebar route="genie://dashboard" deckCount={0} workspaces={[ws('tynn')]} available={['dashboard', 'workspace']} onNavigate={() => {}} railStorage={memory({ 'genie.rail.view': 'workspaces' })} />));
        expect($('[data-rail-list] [data-workspace="tynn"]')).not.toBeNull();
    });
});

describe('the terminal and folder buttons open windows', () => {
    const unit = (id: string) => $(`[data-rail-agent="${id}"]`)!.closest<HTMLElement>('[data-rail-agent-unit]')!;

    it('the terminal button opens that agent’s terminal window and navigates nowhere', () => {
        act(() => root.render(sidebar()));
        const button = unit('a_fancy').querySelector<HTMLElement>('[data-agent-open-terminal]');
        expect(button?.tagName).toBe('BUTTON');
        expect(button?.getAttribute('aria-label')).toBe('Open fancy-one’s terminal in a new window');
        click(button);
        expect(terminals).toEqual(['a_fancy']);
        expect(files).toEqual([]);
        expect(navigated).toEqual([]);
    });

    it('the folder button opens that workspace’s Files window and navigates nowhere', () => {
        act(() => root.render(sidebar()));
        const button = unit('a_fancy').querySelector<HTMLElement>('[data-agent-open-workspace]');
        expect(button?.getAttribute('aria-label')).toBe('Open fancy Files in a new window');
        click(button);
        expect(files).toEqual(['fancy']);
        expect(terminals).toEqual([]);
        expect(navigated).toEqual([]);
    });

    it('without a window opener the buttons are disabled, not a navigation', () => {
        act(() => root.render(sidebar(false)));
        const folder = unit('a_fancy').querySelector<HTMLButtonElement>('[data-agent-open-workspace]')!;
        const terminal = unit('a_fancy').querySelector<HTMLButtonElement>('[data-agent-open-terminal]')!;
        expect(folder.disabled).toBe(true);
        expect(terminal.disabled).toBe(true);
        click(folder); click(terminal);
        expect(navigated).toEqual([]);
    });

    it('the settings gear still navigates (control)', () => {
        act(() => root.render(sidebar()));
        click(unit('a_fancy').querySelector('[data-agent-settings]'));
        expect(navigated).toEqual(['genie://agent/a_fancy?tab=settings']);
    });
});
