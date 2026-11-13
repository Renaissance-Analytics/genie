// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { chatSubjectInScope, routeInScope, windowScopeOf, workspaceHome, type WindowScope } from '../src/core/workspace-window.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * A WORKSPACE-SHARE WINDOW SHOWS ONLY THAT WORKSPACE (Tynn #690; the owner, 2026-11-13: "make sure the genie window UI for
 * workspace shares doesn't show any workstation specific ux").
 *
 * The window's scope is the HOST's welcome (`isOwner`, `workspaceId`, `readonly`; Tynn #688), never a client flag. A guest
 * of one workspace sees that workspace's page, its agents, their chat, its files and terminals; none of the workstation:
 * the sidebar's workspace list, the Dashboard, the Deck, Settings, Hosting (processes, sites, services), Flows, Knowledge,
 * the browser, the host picker, share, Do Not Disturb, the update chip, the AgentInbox, the Command Window, Genie's own
 * agent, the GApp store — and no route to any of them, a deep link included. Read-only shows no send or act controls.
 *
 * Every absence is measured against a WORKSTATION window rendered from the same props (the positive control), so a marker
 * that never draws cannot pass for one that was removed.
 */

const WS = 'tynn';
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: WS, fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
const atlas = row({ id: 'a_atlas', name: 'atlas' });
const bolt = row({ id: 'a_bolt', name: 'bolt', workspaceId: 'fancy' });
const genie = row({ id: 'genie', name: 'Genie', workspaceId: '__genie__' });
const agents = [atlas, bolt];

const WORKSTATION: WindowScope = { kind: 'workstation' };
const CONTROL: WindowScope = { kind: 'workspace', workspaceId: WS, readonly: false };
const READONLY: WindowScope = { kind: 'workspace', workspaceId: WS, readonly: true };

describe('the window’s scope is the host’s welcome, never a client flag', () => {
    const cases: Array<[string, Parameters<typeof windowScopeOf>[0], WindowScope]> = [
        ['no remote (this machine’s own window)', null, WORKSTATION],
        ['not connected yet', { connected: false, isOwner: false, workspaceId: WS, readonly: false }, WORKSTATION],
        ['the owner', { connected: true, isOwner: true, workspaceId: null, readonly: false }, WORKSTATION],
        ['a whole-workstation guest', { connected: true, isOwner: false, workspaceId: null, readonly: false }, WORKSTATION],
        ['a workspace guest', { connected: true, isOwner: false, workspaceId: WS, readonly: false }, CONTROL],
        ['a read-only workspace guest', { connected: true, isOwner: false, workspaceId: WS, readonly: true }, READONLY],
        ['an older host that says nothing of read-only', { connected: true, isOwner: false, workspaceId: WS }, CONTROL],
    ];
    for (const [what, state, scope] of cases) it(what, () => expect(windowScopeOf(state)).toEqual(scope));
});

describe('no route outside the workspace, deep links included', () => {
    const home = workspaceHome(WS);
    const outside = [
        'genie://dashboard', 'genie://deck', 'genie://deck?item=q_1', 'genie://settings', 'genie://settings/remote', 'genie://hosting',
        'genie://hosting?tab=processes', 'genie://hosting?tab=services', 'genie://flows', 'genie://knowledge', 'genie://browser',
        'genie://flow/f1', 'genie://flow/new', 'genie://files/fancy', 'genie://takeover/term_t', 'genie://workspace/fancy',
        'genie://workspace/fancy?view=terminals', 'genie://agent/a_bolt', 'genie://agent/genie', 'genie://agent/nobody', 'genie://inbox',
    ];
    for (const route of outside) {
        it(`${route} → the workspace’s page; a workstation window keeps it (CONTROL)`, () => {
            expect(routeInScope(route, CONTROL, agents)).toBe(home);
            expect(routeInScope(route, READONLY, agents)).toBe(home);
            expect(routeInScope(route, WORKSTATION, agents)).toBe(route);
        });
    }
    const inside = [home, `${home}?view=terminals`, `${home}?view=settings`, 'genie://agent/a_atlas', 'genie://agent/a_atlas?tab=stream'];
    for (const route of inside) it(`${route} stays`, () => expect(routeInScope(route, CONTROL, agents)).toBe(route));

    it('what rides the route stays inside too: no AgentInbox flyout, no chat naming an agent outside', () => {
        expect(routeInScope(`${home}?inbox=`, CONTROL, agents)).toBe(home);
        expect(routeInScope(`${home}?chat=a_bolt`, CONTROL, agents)).toBe(home);
        expect(routeInScope(`${home}?chat=genie`, CONTROL, agents)).toBe(home);
        expect(routeInScope(`${home}?chat=a_atlas`, CONTROL, agents)).toBe(`${home}?chat=a_atlas`);
        expect(routeInScope(`${home}?inbox=`, WORKSTATION, agents)).toBe(`${home}?inbox=`);
    });
});

describe('the chat is one of the workspace’s agents, never Genie’s own or another workspace’s', () => {
    const workspaces = [{ id: WS, defaultAgentId: null }];
    it('Genie, or another workspace’s agent, gives way to the workspace’s', () => {
        expect(chatSubjectInScope('genie', CONTROL, agents, workspaces)).toBe('a_atlas');
        expect(chatSubjectInScope('a_bolt', CONTROL, agents, workspaces)).toBe('a_atlas');
        expect(chatSubjectInScope(null, CONTROL, agents, workspaces)).toBe('a_atlas');
        expect(chatSubjectInScope('a_atlas', CONTROL, agents, workspaces)).toBe('a_atlas');
    });
    it('the workspace’s default agent when it has one; none when it has no agent', () => {
        const two = [...agents, row({ id: 'a_wren', name: 'wren' })];
        expect(chatSubjectInScope('genie', CONTROL, two, [{ id: WS, defaultAgentId: 'a_wren' }])).toBe('a_wren');
        expect(chatSubjectInScope('genie', CONTROL, [bolt], workspaces)).toBeNull();
    });
    it('a workstation window keeps whatever was picked (CONTROL)', () => {
        expect(chatSubjectInScope('genie', WORKSTATION, agents, workspaces)).toBe('genie');
    });
});

describe('the window draws none of the workstation (positive control: a workstation window from the same props)', () => {
    const snapshot: GenieSnapshot = {
        ...EMPTY_SNAPSHOT,
        agents,
        osAgent: genie,
        workspaces: [{ id: WS, name: 'Tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', name: 'Fancy', path: '/w/fancy', agentsKnown: true }] as GenieSnapshot['workspaces'],
        deckItems: [],
        workstation: { name: 'alphar', healthy: true },
        safeMode: { active: true, at: 1, cause: 'the host stopped', crashLoop: false, agents: [], processes: [], sites: [] },
    };
    const features = { ...EMPTY_FEATURES, settings: { values: { do_not_disturb: false } } };
    const thread = { agentId: 'a_atlas', name: 'atlas', fidelity: 'declared' as const, unread: null, messages: [] };
    const render = (route: string, windowScope: WindowScope) => {
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(
            <Shell
                route={route}
                windowScope={windowScope}
                snapshot={snapshot}
                features={features}
                servable={['dashboard', 'deck', 'agent', 'workspace', 'flows', 'knowledge', 'settings', 'hosting', 'browser']}
                agentDetail={null}
                agentResolved={false}
                selectedRowId={null}
                chatThread={thread}
                pinned={null}
                files={NO_FILES}
                remote={{ host: 'alphar', driver: null, driving: false, locked: false, onTakeControl: () => {}, onDisconnect: () => {} }}
                featureAsk={async () => EMPTY_FEATURES}
                onShareWorkstation={() => {}}
                onNavigate={() => {}}
                onOpenAgent={() => {}}
                onAddAgent={() => {}}
                onAddWorkspace={() => {}}
                onOpenPalette={() => {}}
                onSelectRow={() => {}}
                onSend={() => {}}
                onCloseChat={() => {}}
                answeringApproval={null}
                onAnswerApproval={() => {}}
                onAnswerDeckItem={() => {}}
            />,
        );
        return container;
    };

    /** The workstation's chrome, by the handle each draws. */
    const CHROME: Array<[string, string]> = [
        ['the sidebar (every workspace, the switcher)', '[data-rail]'],
        ['the feature icons (GApps store, Knowledge, Flows, Genie OSA)', '[data-feature]'],
        ['the Command Window box', '[data-palette]'],
        ['the mark’s way to the Dashboard', '[data-nav="genie://dashboard"]'],
        ['the workstation chip', '[data-workstation-health]'],
        ['the AgentInbox (the workstation’s mail)', '[data-system-icon="AgentInbox"]'],
        ['Do Not Disturb', '[data-system-icon="DoNotDisturb"]'],
        ['Share this workstation', '[data-action="share-workstation"]'],
        ['the host’s safe-mode banner', '[data-safe-mode]'],
    ];
    for (const [what, selector] of CHROME) {
        it(`no ${what}`, () => {
            expect(render(workspaceHome(WS), WORKSTATION).querySelector(selector), `CONTROL: a workstation window draws ${selector}`).not.toBeNull();
            expect(render(workspaceHome(WS), CONTROL).querySelector(selector)).toBeNull();
            expect(render(workspaceHome(WS), READONLY).querySelector(selector)).toBeNull();
        });
    }

    /** Each surface of the workstation, reached by its own route (as a deep link would). */
    const SURFACES: Array<[string, string]> = [
        ['genie://dashboard', '[data-surface="dashboard"]'],
        ['genie://deck', '[data-surface="deck"]'],
        ['genie://settings', '[data-surface="settings"]'],
        ['genie://hosting?tab=processes', '[data-surface="hosting"]'],
        ['genie://hosting?tab=sites', '[data-surface="hosting"]'],
        ['genie://flows', '[data-surface="flows"]'],
        ['genie://knowledge', '[data-surface="knowledge"]'],
        ['genie://browser', '[data-surface="browser"]'],
        ['genie://workspace/fancy', '[data-surface="workspace"][data-workspace="fancy"]'],
    ];
    for (const [route, selector] of SURFACES) {
        it(`${route} draws its surface in a workstation window, and the workspace’s own page in a workspace window`, () => {
            expect(render(route, WORKSTATION).querySelector(selector), `CONTROL: ${route}`).not.toBeNull();
            for (const scope of [CONTROL, READONLY]) {
                const scoped = render(route, scope);
                expect(scoped.querySelector(selector)).toBeNull();
                expect(scoped.querySelector(`[data-surface="workspace"][data-workspace="${WS}"]`), 'its own workspace’s page instead').not.toBeNull();
            }
        });
    }

    it('the title bar names the workspace, and its mark lands on it', () => {
        const scoped = render(workspaceHome(WS), CONTROL);
        expect(scoped.querySelector('[data-title-workspace="Tynn"]')).not.toBeNull();
        // The mark itself (not any link to the workspace): it lands on the workspace, never the Dashboard.
        expect(scoped.querySelector('[aria-label="Genie — this workspace"]')?.getAttribute('data-nav')).toBe(workspaceHome(WS));
        expect(render(workspaceHome(WS), WORKSTATION).querySelector('[aria-label="Genie — this workspace"]'), 'CONTROL: a workstation window’s mark is the Dashboard’s').toBeNull();
        // The host is still named, loudly: this is another machine's workspace.
        expect(scoped.querySelector('[data-remote-badge]')).not.toBeNull();
    });

    it('read-only: nothing to type into, no Take control; a control share has both (CONTROL)', () => {
        const control = render(workspaceHome(WS), CONTROL);
        expect(control.querySelector('[data-react-fancy-composer-input]')).not.toBeNull();
        expect(control.querySelector('[data-action="take-control"]')).not.toBeNull();
        const readonly = render(workspaceHome(WS), READONLY);
        expect(readonly.querySelector('[data-react-fancy-composer-input]')).toBeNull();
        expect(readonly.querySelector('[data-chat-blocked]')?.textContent).toContain('read-only');
        expect(readonly.querySelector('[data-action="take-control"]')).toBeNull();
    });
});
