// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { EMPTY_SNAPSHOT } from '../src/renderer/bridge.js';
import { TynnTab } from '../src/renderer/components/TynnTab.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE TYNN TAB IS IN THE STRIP WHATEVER IS SELECTED (Tynn #545). The owner, 2026-11-08, with a screenshot: with an agent
 * selected the workspace strip shows Dashboard, Files, the agents, GitHub, +, Settings, and no Tynn; the Tynn pages were
 * reachable only from the workspace dashboard. The strip is drawn twice — on the workspace's own views (Workspace.tsx) and
 * over an agent's page (Shell.tsx) — and only the first was told the workspace has a Tynn tab.
 *
 * Genie 1 had no Tynn tab to match: its workspace showed a Tynn mark and opened tynn.ai in the browser
 * (renderer/pages/master.tsx `tynn.openInBrowser`). So the tab sits where Genie 2 already puts it, next to GitHub.
 *
 * And it opens on the last page used: leaving for an agent unmounts the tab, which used to send you back to Home.
 */
const row = { id: 'a_lark', name: 'lark', provider: 'codex', workspaceId: 'ws', fidelity: 'declared', state: 'idle', duration: '3m', ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null } as unknown as AgentRow;
const detail = { agent: { id: 'a_lark', name: 'lark', provider: 'codex', fidelity: 'declared', cwd: '/srv/ws', instructions: null }, session: null, rows: [] };
const refused = async () => ({ ok: false as const, reason: 'not here' });
const board = { read: refused, act: async () => ({ ok: true as const }), page: refused, pageAct: refused };

const agentPage = (route: string, opts: { linked: boolean; host: boolean }) => renderToStaticMarkup(
    <Shell
        route={route}
        snapshot={{ ...EMPTY_SNAPSHOT, agents: [row], workspaces: [{ id: 'ws', path: '/srv/ws', agentsKnown: true }] } as never}
        servable={['dashboard', 'deck', 'agent', 'workspace']}
        agentDetail={detail as never}
        agentResolved
        selectedRowId={null}
        chatThread={null}
        chatSession={null}
        pinned={null}
        features={{ ...EMPTY_FEATURES, issueWatch: { ws: { linked: opts.linked } } } as never}
        {...(opts.host ? { tynnBoard: board as never } : {})}
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
const TAB = (view: string) => `data-workspace-tab="${view}"`;

describe('the strip over an agent’s page', () => {
    const route = 'genie://agent/a_lark?tab=stream';

    it('a workspace linked to a Tynn project has the Tynn tab, right before GitHub', () => {
        const html = agentPage(route, { linked: true, host: true });
        expect(html).toContain('data-workspace-tabs=""');
        expect(html).toContain(TAB('tynn'));
        expect(html.indexOf(TAB('tynn'))).toBeLessThan(html.indexOf(TAB('github')));
        // Nothing between them: the next tab after Tynn is GitHub.
        expect(html.slice(html.indexOf(TAB('tynn')) + TAB('tynn').length, html.indexOf(TAB('github')))).not.toContain('data-workspace-tab="');
    });

    it('CONTROL: no Tynn link, no Tynn tab (and no GitHub tab)', () => {
        const html = agentPage(route, { linked: false, host: true });
        expect(html).toContain('data-workspace-tabs=""');
        expect(html).not.toContain(TAB('tynn'));
        expect(html).not.toContain(TAB('github'));
    });

    it('CONTROL: a window that cannot show Tynn’s pages does not offer the tab; GitHub stays', () => {
        const html = agentPage(route, { linked: true, host: false });
        expect(html).not.toContain(TAB('tynn'));
        expect(html).toContain(TAB('github'));
    });
});

describe('the Tynn tab opens on the last page used', () => {
    let container: HTMLElement;
    let root: Root;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        window.localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    const mount = async (workspaceId: string, host: unknown = board, initialSection?: 'features') => {
        await act(async () => root.render(<TynnTab key={workspaceId} workspaceId={workspaceId} host={host as never} {...(initialSection ? { initialSection } : {})} />));
    };
    const remount = async (workspaceId: string, host: unknown = board, initialSection?: 'features') => {
        await act(async () => root.unmount());
        root = createRoot(container);
        await mount(workspaceId, host, initialSection);
    };
    const pick = async (id: string) => { await act(async () => { (container.querySelector(`[data-tynn-section="${id}"]`) as HTMLElement).click(); }); };
    const onSection = () => [...container.querySelectorAll('[data-tynn-section]')].filter((e) => e.className.includes(' bg-[var(--bg-2)] text-[var(--fg-1)]')).map((e) => e.getAttribute('data-tynn-section'));

    it('CONTROL: the first time, it opens on Home', async () => {
        await mount('w1');
        expect(onSection()).toEqual(['home']);
    });

    it('leave and come back: the page you were on', async () => {
        await mount('w1');
        await pick('wip');
        expect(onSection()).toEqual(['wip']);
        await remount('w1');
        expect(onSection()).toEqual(['wip']);
    });

    it('each workspace keeps its own', async () => {
        await mount('w1');
        await pick('releases');
        await remount('w2');
        expect(onSection()).toEqual(['home']);
        await remount('w1');
        expect(onSection()).toEqual(['releases']);
    });

    it('a link that names a page still wins', async () => {
        await mount('w1');
        await pick('wip');
        await remount('w1', board, 'features');
        expect(onSection()).toEqual(['features']);
    });

    it('a remembered page this window cannot show falls back; Issues is offered only with its door', async () => {
        await mount('w1');
        await pick('wip');
        await remount('w1', { read: refused, act: board.act });
        expect(container.querySelector('[data-tynn-tab]')).not.toBeNull();
        expect(onSection()).toEqual([]); // one page offered: no nav, and the board is what is shown
    });
});
