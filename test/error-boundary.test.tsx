// @vitest-environment happy-dom
/**
 * ONE SURFACE'S RENDER ERROR STAYS IN THAT SURFACE (parity audit 2026-10-30, top-15 #7).
 *
 * Genie 2's renderer had no error boundary at all, so one render throw anywhere unmounted the whole tree and left the
 * window blank until a reload. Genie 1 (v0.7.0-beta.342) had one at the root (`renderer/pages/_app.tsx:91`) and compact,
 * per-panel ones (`renderer/components/Master/TerminalGrid.tsx:552`, `renderer/pages/settings.tsx:992`), from
 * `renderer/components/ErrorBoundary.tsx`: a small card naming the panel, the error, Retry, and `resetKeys` so moving away
 * recovers without a reload.
 *
 * A boundary catching a throw is a claim about React's commit — a static render (renderToStaticMarkup) does not use
 * boundaries at all — so this file renders in a DOM (happy-dom, scoped here; docs/decisions.md D4).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { ChatDraftKeeper } from '../src/core/chat-draft-keeper.js';
import { RENDER_ERROR_PREFIX } from '../src/core/render-error.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, NO_FILES, NO_TERMINALS, type AgentDetail, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { ChatThread } from '../src/renderer/components/ChatFlyout.js';
import { ErrorBoundary } from '../src/renderer/components/ErrorBoundary.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * Which surface throws on its next render, and the wrapper that makes it. Hoisted with the mocks (vi.mock factories run
 * before the file's own top level); each factory passes React's createElement in, so a memoised view (AgentView, the
 * chat) is still drawn as an element.
 */
const { boom, thrower, ce } = vi.hoisted(() => {
    const boom = { Dashboard: false, AgentView: false, ChatFlyout: false, InboxFlyout: false, Deck: false, Workspace: false, TynnBoardTab: false };
    const thrower = (ce: (type: never, props: never) => unknown, name: keyof typeof boom, real: unknown) => (p: object) => {
        if (boom[name]) throw new Error(`${name} exploded`);
        return ce(real as never, p as never);
    };
    const ce = async () => (await import('react')).createElement as (type: never, props: never) => unknown;
    return { boom, thrower, ce };
});
vi.mock('../src/renderer/components/Dashboard.js', async (orig) => { const m = await orig<typeof import('../src/renderer/components/Dashboard.js')>(); return { ...m, Dashboard: thrower(await ce(), 'Dashboard', m.Dashboard) }; });
vi.mock('../src/renderer/components/AgentView.js', async (orig) => { const m = await orig<typeof import('../src/renderer/components/AgentView.js')>(); return { ...m, AgentView: thrower(await ce(), 'AgentView', m.AgentView) }; });
vi.mock('../src/renderer/components/ChatFlyout.js', async (orig) => { const m = await orig<typeof import('../src/renderer/components/ChatFlyout.js')>(); return { ...m, ChatFlyout: thrower(await ce(), 'ChatFlyout', m.ChatFlyout) }; });
vi.mock('../src/renderer/components/InboxFlyout.js', async (orig) => { const m = await orig<typeof import('../src/renderer/components/InboxFlyout.js')>(); return { ...m, InboxFlyout: thrower(await ce(), 'InboxFlyout', m.InboxFlyout) }; });
vi.mock('../src/renderer/components/Deck.js', async (orig) => { const m = await orig<typeof import('../src/renderer/components/Deck.js')>(); return { ...m, Deck: thrower(await ce(), 'Deck', m.Deck) }; });
vi.mock('../src/renderer/components/Workspace.js', async (orig) => { const m = await orig<typeof import('../src/renderer/components/Workspace.js')>(); return { ...m, Workspace: thrower(await ce(), 'Workspace', m.Workspace) }; });
vi.mock('../src/renderer/components/TynnBoardPanel.js', async (orig) => { const m = await orig<typeof import('../src/renderer/components/TynnBoardPanel.js')>(); return { ...m, TynnBoardTab: thrower(await ce(), 'TynnBoardTab', m.TynnBoardTab) }; });

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; genieClipboard?: { write(text: string): Promise<boolean> } };

function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: 'ws_alpha', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over } as AgentRow;
}
const snapshot: GenieSnapshot = {
    ...EMPTY_SNAPSHOT,
    agents: [row({ id: 'a_atlas', name: 'atlas' })],
    workspaces: [{ id: 'ws_alpha', path: '/w/alpha', name: 'alpha', agentsKnown: true }],
    deckItems: [],
} as GenieSnapshot;
const detail: AgentDetail = {
    agent: { id: 'a_atlas', name: 'atlas', workspaceId: 'ws_alpha', provider: 'claude', fidelity: 'declared', cwd: '/w/alpha', instructions: null },
    session: null, rows: [], turns: 0, cost: null, refusal: null,
} as AgentDetail;
const thread: ChatThread = { agentId: 'a_atlas', name: 'atlas', fidelity: 'declared', unread: null, loaded: true, messages: [] };

describe('a render error stays in the surface that threw (the real Shell, rendered)', () => {
    let host: HTMLElement;
    let root: Root;
    let errors: MockInstance<typeof console.error>;
    const keeper = new ChatDraftKeeper({ load: async () => ({}), save: async () => {}, putFile: async () => null, readFile: async () => null, release: async () => {} }, { setTimer: () => 0, clearTimer: () => {} });
    const draw = (route: string) => (
        <Shell
            route={route}
            snapshot={snapshot}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={detail}
            agentResolved
            selectedRowId={null}
            chatThread={thread}
            chatDrafts={keeper}
            openedThreads={['a_atlas']}
            pinned={null}
            files={NO_FILES}
            featureAsk={async () => { throw new Error('not in this test'); }}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onToggleFilesPin={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
        />
    );
    const failed = (name: string) => host.querySelector(`[data-surface-failed="${name}"]`);

    beforeEach(async () => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        await keeper.load();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        // React itself reports a caught error to console.error too; the boundary's own line is asserted below.
        errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        for (const k of Object.keys(boom) as Array<keyof typeof boom>) boom[k] = false;
        errors.mockRestore();
        delete g.genieClipboard;
    });

    it('POSITIVE CONTROL: with nothing throwing, every surface draws and no failure card is shown', async () => {
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas')));
        expect(host.querySelector('[data-surface="dashboard"]')).not.toBeNull();
        expect(host.querySelector('[data-chat="pinned"]')).not.toBeNull();
        expect(host.querySelector('[data-title-bar]')).not.toBeNull();
        expect(host.querySelector('[data-surface-failed]')).toBeNull();
    });

    it('the Dashboard throwing shows its own card (the error, Retry, Copy details) — the title bar and the chat still draw', async () => {
        boom.Dashboard = true;
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas')));
        const card = failed('Dashboard');
        expect(card, 'no failure card for the Dashboard').not.toBeNull();
        expect(card!.textContent).toMatch(/Dashboard exploded/);
        expect(card!.querySelector('button[data-surface-retry]')?.textContent).toMatch(/Retry/);
        expect(card!.querySelector('button[data-surface-copy]')?.textContent).toMatch(/Copy details/);
        expect(host.querySelector('[data-title-bar]')).not.toBeNull();
        expect(host.querySelector('[data-chat="pinned"]')).not.toBeNull();
    });

    it('Retry draws the surface again — once it no longer throws, it is back', async () => {
        boom.Dashboard = true;
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas')));
        expect(failed('Dashboard')).not.toBeNull();
        boom.Dashboard = false;
        await act(async () => { (failed('Dashboard')!.querySelector('button[data-surface-retry]') as HTMLButtonElement).click(); });
        expect(failed('Dashboard')).toBeNull();
        expect(host.querySelector('[data-surface="dashboard"]')).not.toBeNull();
    });

    it('Copy details copies the surface, the error and its stack through main\'s clipboard', async () => {
        const written: string[] = [];
        g.genieClipboard = { write: async (text: string) => { written.push(text); return true; } };
        boom.Dashboard = true;
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas')));
        await act(async () => { (failed('Dashboard')!.querySelector('button[data-surface-copy]') as HTMLButtonElement).click(); });
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/Dashboard/);
        expect(written[0]).toMatch(/Dashboard exploded/);
        expect(written[0]).toMatch(/error-boundary\.test\.tsx/); // the stack
    });

    it('the error is logged as one line main forwards to Genie\'s log', async () => {
        boom.Dashboard = true;
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas')));
        const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(RENDER_ERROR_PREFIX));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/surface=Dashboard/);
        expect(lines[0]).toMatch(/Dashboard exploded/);
    });

    it('moving to another page recovers the main area without a Retry (resetKeys, as Genie 1)', async () => {
        boom.Dashboard = true;
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas')));
        expect(failed('Dashboard')).not.toBeNull();
        boom.Dashboard = false;
        await act(async () => root.render(draw('genie://deck?chat=a_atlas')));
        expect(host.querySelector('[data-surface-failed]')).toBeNull();
        expect(host.querySelector('[data-surface="deck"]')).not.toBeNull();
    });

    it('the agent view throwing keeps the chat and the title bar', async () => {
        boom.AgentView = true;
        await act(async () => root.render(draw('genie://agent/a_atlas?tab=stream&chat=a_atlas')));
        expect(failed('Agent view')).not.toBeNull();
        expect(host.querySelector('[data-chat="pinned"]')).not.toBeNull();
        expect(host.querySelector('[data-title-bar]')).not.toBeNull();
    });

    it('the chat throwing keeps the page beside it', async () => {
        boom.ChatFlyout = true;
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas')));
        expect(failed('Chat')).not.toBeNull();
        expect(host.querySelector('[data-surface="dashboard"]')).not.toBeNull();
    });

    it('the AgentInbox flyout throwing keeps the page and the chat', async () => {
        boom.InboxFlyout = true;
        await act(async () => root.render(draw('genie://dashboard?chat=a_atlas&inbox=')));
        expect(failed('AgentInbox')).not.toBeNull();
        expect(host.querySelector('[data-surface="dashboard"]')).not.toBeNull();
        expect(host.querySelector('[data-chat="pinned"]')).not.toBeNull();
    });

    it('the Deck throwing keeps the chat', async () => {
        boom.Deck = true;
        await act(async () => root.render(draw('genie://deck?chat=a_atlas')));
        expect(failed('Deck')).not.toBeNull();
        expect(host.querySelector('[data-chat="pinned"]')).not.toBeNull();
    });

    it('the workspace page throwing keeps the chat and the rail', async () => {
        boom.Workspace = true;
        await act(async () => root.render(draw('genie://workspace/ws_alpha?chat=a_atlas')));
        expect(failed('Workspace')).not.toBeNull();
        expect(host.querySelector('[data-chat="pinned"]')).not.toBeNull();
        expect(host.querySelector('[data-title-bar]')).not.toBeNull();
    });
});

describe('the Tynn tab throwing keeps the workspace around it', () => {
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
        boom.TynnBoardTab = false;
        errors.mockRestore();
    });

    it('a card for the Tynn tab, inside a workspace page that still draws its tab strip', async () => {
        boom.TynnBoardTab = true;
        const issueWatch = { linked: true } as never;
        await act(async () => root.render(<Workspace view="tynn" workspace={{ id: 'ws_alpha', name: 'alpha', path: '/w/alpha' }} terminals={NO_TERMINALS} issueWatch={issueWatch} tynnBoard={{} as never} />));
        expect(host.querySelector('[data-surface-failed="Tynn"]')).not.toBeNull();
        expect(host.querySelector('[data-surface="workspace"]')).not.toBeNull();
    });
});

describe('the boundary itself', () => {
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
    afterEach(() => { act(() => root.unmount()); host.remove(); errors.mockRestore(); });

    const Bad = ({ fail }: { fail: boolean }) => { if (fail) throw new Error('bad render'); return <p data-ok="">fine</p>; };

    it('the whole-window variant (the root) offers Reload as well as Retry', async () => {
        await act(async () => root.render(<ErrorBoundary surface="Genie" whole><Bad fail /></ErrorBoundary>));
        const card = host.querySelector('[data-surface-failed="Genie"]');
        expect(card).not.toBeNull();
        expect(card!.getAttribute('data-whole')).toBe('true');
        expect(card!.querySelector('button[data-surface-reload]')).not.toBeNull();
        expect(card!.querySelector('button[data-surface-retry]')).not.toBeNull();
    });

    it('resets when its resetKeys change, and not otherwise', async () => {
        await act(async () => root.render(<ErrorBoundary surface="X" resetKeys={['a']}><Bad fail /></ErrorBoundary>));
        expect(host.querySelector('[data-surface-failed="X"]')).not.toBeNull();
        await act(async () => root.render(<ErrorBoundary surface="X" resetKeys={['a']}><Bad fail={false} /></ErrorBoundary>));
        expect(host.querySelector('[data-surface-failed="X"]'), 'reset with the same keys').not.toBeNull();
        await act(async () => root.render(<ErrorBoundary surface="X" resetKeys={['b']}><Bad fail={false} /></ErrorBoundary>));
        expect(host.querySelector('[data-surface-failed="X"]')).toBeNull();
        expect(host.querySelector('[data-ok]')).not.toBeNull();
    });
});
