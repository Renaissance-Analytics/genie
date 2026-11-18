// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { addressOf, routeOfAddress, type AddressContext } from '../src/core/address.js';
import { issueWatchPanelView, parseIssueWatchEntry } from '../src/core/issue-watch.js';
import { formatRoute, parseRoute, type Route } from '../src/core/route.js';
import { workspaceViewRoute } from '../src/core/workspace-tabs.js';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * EVERY WORKSPACE TAB OPENS ITS PANEL (the owner on beta.64, 2026-11-17: "the artboard and storage tabs don't do
 * anything").
 *
 * The strip asked for the view and the Workspace drew it (artboard-workspace-tab, workspace-storage-ui-697 prove each
 * half), but a click goes through the window's ADDRESS between the two: App.navigate writes addressOf(route) into the
 * hash and reads the route back with routeOfAddress (core/address.ts). That module kept its own list of tab words, and
 * ArtBoard (#739) and Storage (#697) never joined it, so `view=artboard` was written as `…/<slug>/dashboard` and read
 * back as the Dashboard: the click landed where it started. The agent page's strip had a second gap on the same path:
 * its Files tab asked workspaceViewRoute for `view=files`, which is not a view, and landed on the Dashboard too.
 *
 * This walks the WHOLE path for every tab the strip draws: the tab's value, the route the strip navigates to, the address
 * the window shows, the route read back from it, and the Workspace rendering that route, which must select the tab and
 * draw a non-empty body for it.
 */
const WS = 'ws_acme';
const ctx: AddressContext = {
    workstation: 'alphar',
    workspaces: [{ id: WS, name: 'Acme', path: '/w/acme' }],
    agents: [{ id: 'a1', name: 'atlas', workspaceId: WS }],
    tabsOf: (id) => (id === WS ? [{ id: 'tab-1', name: 'Ops board' }] : []),
};
const designed = { tabs: [{ id: 'tab-1', name: 'Ops board', layout: 'single' as const, cells: [null] }] };
const settingsOps: WorkspaceOpsProps = {
    asleep: false, agentCount: 1, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    settings: { values: { workspace_tabs: JSON.stringify(designed) }, overridden: [], onSet: () => {}, onClear: () => {} } as never,
};
/** A linked workspace's GitHub view, built as main builds it: live, nothing open. */
const issueWatch = issueWatchPanelView({ state: 'live', linked: true, entry: parseIssueWatchEntry({ projectId: 'p1', items: [], feedbackItems: [] })! }, []);
const board = { pluginId: 'ai.genie.artboard', pluginName: 'ArtBoard', id: 'board', title: 'ArtBoard', fancyComponent: { export: 'ArtBoardPanel' as const }, props: {} };

/** Every tab value the strip draws with everything on (an agent, a designed tab, Tynn, GitHub, Storage); not the + nor the agent. */
function stripValues(): string[] {
    const html = renderToStaticMarkup(<WorkspaceTabs designed={designed} agents={[{ id: 'a1', name: 'atlas', state: 'idle' }]} current={{ kind: 'view', view: 'home' }} canDesign hasSettings github tynn storage onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} />);
    return [...html.matchAll(/data-workspace-tab="([^"]+)"/g)].map((m) => m[1]!).filter((v) => v !== 'add' && !v.startsWith('agent:'));
}

/** Pick → route → the address in the hash → the route read back from it (App.navigate's path). */
function throughTheAddress(view: string): Route {
    const address = addressOf(workspaceViewRoute(WS, view), ctx);
    const back = routeOfAddress(address, ctx);
    expect(back, `${view}: ${address} names nothing`).not.toBeNull();
    return parseRoute(back!);
}

/** The element each tab's body is drawn in. */
const BODY: Record<string, string> = {
    home: '[data-workspace-body="home"]',
    files: '[data-workspace-body="files"]',
    artboard: '[data-workspace-body="artboard"]',
    'tab:tab-1': '[data-designed-tab="tab-1"]',
    tynn: '[data-workspace-body="tynn"]',
    github: '[data-workspace-body="github"]',
    storage: '[data-workspace-body="storage"]',
    settings: '[data-workspace-settings]',
};

describe('the strip with everything on (COUNTED)', () => {
    it('draws 8 views: Dashboard, Files, ArtBoard, the designed tab, Tynn, GitHub, Storage, Settings', () => {
        expect(stripValues()).toEqual(['home', 'files', 'artboard', 'tab:tab-1', 'tynn', 'github', 'storage', 'settings']);
        // Every one has a body to look for: a new tab kind fails here until its body is named.
        for (const v of stripValues()) expect(BODY[v], v).toBeDefined();
    });
});

describe('a tab survives the window address', () => {
    it.each(['artboard', 'storage'])('%s: the route read back is the same view, not the Dashboard', (view) => {
        const r = throughTheAddress(view);
        expect(r.surface).toBe('workspace');
        expect(r.surface === 'workspace' ? r.view : null).toBe(view);
    });

    it('files (the agent page\'s strip): the route read back has the files open', () => {
        const r = throughTheAddress('files');
        expect(r.surface).toBe('workspace');
        expect(r.surface === 'workspace' ? r.panel : null).toBe('files');
    });

    it('an ArtBoard link to one item keeps its item through the address (Tynn #739)', () => {
        const base = parseRoute(`genie://workspace/${WS}?view=artboard&item=art_42`);
        const back = parseRoute(routeOfAddress(addressOf(formatRoute(base), ctx), ctx)!);
        expect(back.surface === 'workspace' ? [back.view, back.artboardItem] : null).toEqual(['artboard', 'art_42']);
    });

    it.each(['home', 'settings', 'github', 'tynn', 'tab:tab-1'])('CONTROL %s: already survived', (view) => {
        const r = throughTheAddress(view);
        expect(r.surface === 'workspace' ? r.view : null).toBe(view);
        expect(r.surface === 'workspace' ? r.panel : 'x').toBeNull();
    });
});

describe('every tab, through the address, opens a non-empty panel', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLElement;
    let root: Root;
    let errors: MockInstance<typeof console.error>;
    beforeEach(() => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        errors.mockRestore();
    });

    it.each(stripValues())('%s', async (view) => {
        const r = throughTheAddress(view);
        if (r.surface !== 'workspace') throw new Error(`${view}: not a workspace route`);
        await act(async () => root.render(
            <Workspace
                workspace={{ id: WS, name: 'Acme', path: '/w/acme' }}
                terminals={NO_TERMINALS}
                files={NO_FILES}
                onTogglePanel={() => {}}
                view={r.view}
                panel={r.panel}
                ops={settingsOps}
                pluginPanels={[board]}
                agentTabs={[{ id: 'a1', name: 'atlas', state: 'idle' }]}
                issueWatch={issueWatch}
                tynnBoard={{} as never}
                storage={null}
                onStorageAction={() => {}}
            />,
        ));
        expect(host.querySelector(`[data-workspace-tab="${view}"]`)?.getAttribute('aria-selected'), `${view} is the selected tab`).toBe('true');
        const body = host.querySelector(BODY[view]!);
        expect(body, `${view}: its body ${BODY[view]} is drawn`).not.toBeNull();
        expect(body!.textContent!.trim().length, `${view}: its body is not empty`).toBeGreaterThan(0);
        expect(host.querySelector('[data-surface-failed]'), `${view}: no surface failed`).toBeNull();
    });
});
