// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { windowEntriesFor, WINDOW_ENTRIES, type AgentRow } from '../src/core/dashboard-view.js';
import { parseRoute } from '../src/core/route.js';
import { terminalsWindowRoute } from '../src/core/workspace-window.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { Shell } from '../src/renderer/Shell.js';
import { markupRoot, nodeText } from './helpers/markup-text.js';

/**
 * THE DASHBOARD'S WINDOWS COLUMN (Tynn #706): an icon-only header with a tooltip; each agent row has an icon Button that
 * opens a menu of exactly two entries, Terminal and Files; each opens a NEW window for the row's workspace and the current
 * window goes nowhere. A workspace-share window only ever offers its own workspace.
 */
const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null,
    reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
    commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});
const AGENTS: AgentRow[] = [
    row({ id: 'a_tynn', name: 'atlas', workspaceId: 'tynn' }),
    row({ id: 'a_fancy', name: 'borealis', workspaceId: 'fancy' }),
];
const WORKSPACES = [{ id: 'tynn', path: '/w/tynn', name: 'tynn' }, { id: 'fancy', path: '/w/fancy', name: 'fancy' }];

describe('the menu entries are data, and the scope is a rule', () => {
    it('are exactly Terminal and Files, in that order', () => {
        expect(WINDOW_ENTRIES.map((e) => e.label)).toEqual(['Terminal', 'Files']);
        expect(WINDOW_ENTRIES.map((e) => e.kind)).toEqual(['terminal', 'files']);
    });
    it('a workstation window offers every workspace', () => {
        expect(windowEntriesFor('tynn', null)).toHaveLength(2);
        expect(windowEntriesFor('fancy', undefined)).toHaveLength(2);
    });
    it('a workspace window offers its own workspace and nothing else (CONTROL: its own is not empty)', () => {
        expect(windowEntriesFor('tynn', 'tynn')).toHaveLength(2);
        expect(windowEntriesFor('fancy', 'tynn')).toEqual([]);
    });
});

describe('the Terminal window is the workspace’s terminals view', () => {
    it('its route parses to that workspace on its terminals view', () => {
        const parsed = parseRoute(terminalsWindowRoute('tynn'));
        expect(parsed).toMatchObject({ surface: 'workspace', workspaceId: 'tynn', view: 'terminals' });
    });
    it('is the same route for the same workspace, so a second click finds the window already open', () => {
        expect(terminalsWindowRoute('tynn')).toBe(terminalsWindowRoute('tynn'));
        expect(terminalsWindowRoute('tynn')).not.toBe(terminalsWindowRoute('fancy'));
    });
});

describe('the column header', () => {
    it('is an icon with a tooltip and no words', () => {
        const html = renderToStaticMarkup(<Dashboard rows={AGENTS} workspaces={WORKSPACES} onOpenAgent={() => {}} onAddAgent={() => {}} />);
        const cell = markupRoot(html).querySelector('div[data-column-header="windows"]');
        expect(cell, 'a windows header cell').not.toBeNull();
        // The cell, or something in it, carries a non-empty tooltip and accessible name.
        const carries = (name: string) => [cell!, ...Array.from(cell!.querySelectorAll('*'))].some((e) => (e.getAttribute(name) ?? '') !== '');
        expect(carries('title'), 'a title').toBe(true);
        expect(carries('aria-label'), 'an aria-label').toBe(true);
        // No text anywhere inside it.
        expect(nodeText(cell!).trim()).toBe('');
        expect(cell!.querySelector('span, svg'), 'an icon').not.toBeNull();
    });
});

describe('the row menu (happy-dom)', () => {
    let host: HTMLDivElement;
    let root: Root;
    let terminals: string[];
    let files: string[];
    let opened: string[];
    let navigated: string[];
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        terminals = []; files = []; opened = []; navigated = [];
        window.localStorage.clear();
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        document.body.innerHTML = '';
        window.localStorage.clear();
    });
    const mount = (over: Partial<Parameters<typeof Dashboard>[0]> = {}) => act(() => root.render(
        <Dashboard
            rows={AGENTS} workspaces={WORKSPACES} onOpenAgent={(id) => opened.push(id)} onAddAgent={() => {}} onNavigate={(r) => navigated.push(r)}
            onOpenTerminalWindow={(id) => terminals.push(id)} onOpenFilesWindow={(id) => files.push(id)} {...over}
        />,
    ));
    const click = (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => (el as HTMLElement).click()); };
    const trigger = (agent: string) => host.querySelector<HTMLButtonElement>(`[data-agent="${agent}"] [data-windows-menu]`);
    const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];

    it('every agent row has an icon Button named for its agent, and nothing else of words', () => {
        mount();
        for (const [id, name] of [['a_tynn', 'atlas'], ['a_fancy', 'borealis']] as const) {
            const button = trigger(id);
            expect(button?.tagName).toBe('BUTTON');
            expect(button?.getAttribute('aria-label')).toBe(`Open ${name} in a new window`);
            expect(button?.textContent?.trim()).toBe('');
        }
    });

    it('opens a menu of exactly Terminal and Files', () => {
        mount();
        expect(items()).toEqual([]);
        click(trigger('a_tynn'));
        expect(items().map((i) => i.textContent!.trim())).toEqual(['Terminal', 'Files']);
    });

    it('Terminal opens the row’s workspace terminals window and the current window goes nowhere', () => {
        mount();
        click(trigger('a_fancy'));
        click(items()[0]);
        expect(terminals).toEqual(['fancy']);
        expect(files).toEqual([]);
        expect(navigated).toEqual([]);
        expect(opened, 'the row itself was not clicked').toEqual([]);
    });

    it('Files opens the row’s workspace Files window and the current window goes nowhere', () => {
        mount();
        click(trigger('a_tynn'));
        click(items()[1]);
        expect(files).toEqual(['tynn']);
        expect(terminals).toEqual([]);
        expect(navigated).toEqual([]);
        expect(opened).toEqual([]);
    });

    it('CONTROL: clicking the row still opens the agent', () => {
        mount();
        click(host.querySelector('[data-agent="a_tynn"]'));
        expect(opened).toEqual(['a_tynn']);
    });

    it('a workspace window shows the menu on its own workspace’s rows only', () => {
        mount({ scopeWorkspaceId: 'tynn' });
        expect(trigger('a_tynn')).not.toBeNull();
        expect(trigger('a_fancy')).toBeNull();
    });

    it('Genie’s own row has no menu (it has no workspace to open)', () => {
        mount({ genie: row({ id: 'genie', name: 'genie', workspaceId: '__genie__' }) });
        expect(host.querySelector('[data-agent="genie"]')).not.toBeNull();
        expect(trigger('genie')).toBeNull();
        expect(trigger('a_tynn')).not.toBeNull();
    });

    it('without any window opener the button is disabled, never a navigation', () => {
        mount({ onOpenTerminalWindow: undefined, onOpenFilesWindow: undefined });
        const button = trigger('a_tynn');
        expect(button?.disabled).toBe(true);
        click(button);
        expect(items()).toEqual([]);
        expect(navigated).toEqual([]);
    });
});

describe('the Shell hands the Dashboard its window openers', () => {
    const snapshot: GenieSnapshot = {
        ...EMPTY_SNAPSHOT,
        agents: AGENTS,
        workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }],
        deckItems: [],
        signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
        workstation: { name: 'alphar', healthy: true },
    };
    const render = (over: Partial<Parameters<typeof Shell>[0]> = {}) => renderToStaticMarkup(
        <Shell
            route="genie://dashboard" snapshot={snapshot} servable={['dashboard', 'agent', 'workspace']} agentDetail={null} agentResolved={false}
            selectedRowId={null} chatThread={null} pinned={null} files={NO_FILES} onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}}
            onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onToggleFilesPin={() => {}} onCloseChat={() => {}}
            answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}} {...over}
        />,
    );
    const menuButtons = (html: string) => [...html.matchAll(/<button\b[^>]*data-windows-menu[^>]*>/g)].map((m) => m[0]);

    it('with openers the buttons are live; without them they are disabled (control)', () => {
        const live = menuButtons(render({ onPopOutFiles: () => {}, onPopOutTerminals: () => {} }));
        expect(live).toHaveLength(2);
        // `disabled` as an attribute, not as the `disabled:` utility inside a class.
        const isDisabled = (b: string) => /\sdisabled(=|\s|>)/.test(b);
        expect(live.filter(isDisabled)).toEqual([]);
        const dead = menuButtons(render());
        expect(dead).toHaveLength(2);
        expect(dead.filter((b) => !isDisabled(b))).toEqual([]);
    });

    it('a workspace-share window never reaches the Dashboard, so it offers no menu', () => {
        const html = render({ windowScope: { kind: 'workspace', workspaceId: 'tynn', readonly: false }, onPopOutFiles: () => {}, onPopOutTerminals: () => {} });
        expect(menuButtons(html)).toEqual([]);
    });
});
