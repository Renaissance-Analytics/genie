import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Drawer } from '@particle-academy/react-fancy';
import type { DeckItem } from '../src/core/deck.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { inboxThreads, pairKey, type ThreadMail } from '../src/core/inbox-threads.js';
import { railWorkspaces } from '../src/core/rail-view.js';
import { WORKSPACE_PALETTE } from '../src/core/workspace-color.js';
import { EMPTY_TOASTS, toastReducer, toastView } from '../src/core/approval-toasts.js';
import { AlertToasts } from '../src/renderer/components/AlertToasts.js';
import { ApprovalToastStack } from '../src/renderer/components/ApprovalToasts.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { InboxFlyoutView, type InboxFlyoutViewProps } from '../src/renderer/components/InboxFlyout.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { WorkspaceColorPicker } from '../src/renderer/components/WorkspaceColorPicker.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';
import { WorkspaceColorsContext, workspaceColorMap, type WorkspaceColorMap } from '../src/renderer/workspace-colors.js';

/**
 * A WORKSPACE'S COLOUR, WHEREVER YOU COULD MISTAKE WHO YOU ARE ADDRESSING (genie#1300). The owner: "We need workspace
 * color customization so it's always easy to tell who a user is talking to" — and, 2026-10-27, "I need that workspace
 * styling soon so I can tell my agents apart".
 *
 * Every surface marks the colour with `data-workspace-color="<hex>"` (its swatch or edge) and sets it as `--ws`, which
 * its classes read. Each is also checked to keep the NAME beside the colour: colour is never the only cue. A surface with
 * no colour known draws no swatch at all — never an empty one.
 *
 * As everywhere in this suite (docs/decisions.md D3), these are claims about MARKUP, rendered with react-dom/server — not
 * that the colour looks right on a screen.
 */

const TEAL = '#0891b2';
const PINK = '#db2777';
const marked = (html: string, color = TEAL) => html.includes(`data-workspace-color="${color}"`) && html.includes(`--ws:${color}`);
const noop = () => {};

describe('the sidebar row', () => {
    const rail = (color?: string) => renderToStaticMarkup(
        <Sidebar route="genie://dashboard" deckCount={0} available={['dashboard', 'workspace']} onNavigate={noop}
            workspaces={railWorkspaces([{ id: 'tynn', name: 'Tynn', path: '/w/tynn', agentsKnown: true, ...(color ? { color } : {}) }], [])} />,
    );

    it('carries the colour from the snapshot through railWorkspaces, beside the name', () => {
        const html = rail(TEAL);
        expect(marked(html)).toBe(true);
        expect(html).toMatch(/data-workspace="tynn"[\s\S]*data-workspace-color="#0891b2"[\s\S]*Tynn/);
    });

    it('no colour, no swatch', () => {
        expect(rail()).not.toContain('data-workspace-color');
    });
});

describe('the title bar, while a workspace is on screen', () => {
    const bar = (workspace?: { name: string; color: string | null }) => renderToStaticMarkup(
        <TitleBar route="genie://workspace/tynn" workstation={null} onNavigate={noop} onOpenPalette={noop} platform="generic" {...(workspace ? { workspace } : {})} />,
    );

    it('names the workspace with its colour', () => {
        const html = bar({ name: 'Tynn', color: TEAL });
        expect(marked(html)).toBe(true);
        expect(html).toMatch(/data-title-workspace="Tynn"[\s\S]*Tynn/);
    });

    it('off a workspace there is nothing; a workspace with no colour yet is named without a swatch', () => {
        expect(bar()).not.toContain('data-title-workspace');
        const plain = bar({ name: 'Tynn', color: null });
        expect(plain).toContain('data-title-workspace="Tynn"');
        expect(plain).not.toContain('data-workspace-color');
    });
});

describe('the workspace tab strip and its agent tabs', () => {
    const tabs = (color?: string | null) => renderToStaticMarkup(
        <WorkspaceTabs designed={{ tabs: [] } as never} agents={[{ id: 'a1', name: 'kai', state: 'working' }]} current={{ kind: 'agent', id: 'a1' }}
            canDesign={false} hasSettings onView={noop} onAdd={noop} onOpenAgent={noop} {...(color !== undefined ? { color } : {})} />,
    );

    it('the strip is edged in the colour, and the agent tab on screen is underlined in it', () => {
        const html = tabs(TEAL);
        expect(marked(html)).toBe(true);
        expect(html).toMatch(/data-workspace-tab="agent:a1"[^>]*data-current="true"[^>]*class="[^"]*border-\[var\(--ws\)\]/);
        expect(html).toContain('kai');
    });

    it('no colour: the strip draws as before', () => {
        expect(tabs(null)).not.toContain('data-workspace-color');
        expect(tabs(null)).not.toContain('var(--ws)');
    });
});

describe('the chat: its header and its composer edge', () => {
    const colors: WorkspaceColorMap = { workspaces: { tynn: TEAL }, agents: { a1: TEAL } };
    const chat = (agentColors = colors) => renderToStaticMarkup(
        <WorkspaceColorsContext.Provider value={agentColors}>
            <ChatFlyout thread={{ agentId: 'a1', name: 'kai', fidelity: 'declared', unread: null, messages: [] }} onSend={noop} onClose={noop} />
        </WorkspaceColorsContext.Provider>,
    );

    it('the header carries the agent\'s workspace colour beside its name; the composer is edged in it', () => {
        const html = chat();
        expect(marked(html)).toBe(true);
        expect(html).toMatch(/data-chat-header=""[\s\S]*data-workspace-color="#0891b2"[\s\S]*kai/);
        expect(html).toMatch(/data-composer-edge="#0891b2"/);
    });

    it('an agent whose workspace has no colour gets neither', () => {
        const html = chat({ workspaces: {}, agents: {} });
        expect(html).not.toContain('data-workspace-color');
        expect(html).not.toContain('data-composer-edge');
    });
});

describe('AgentInbox threads', () => {
    const T = Date.UTC(2026, 9, 27, 12);
    const mail: ThreadMail[] = [
        { seq: 1, id: 'msg_1', from: 'agent_kai', to: 'human', text: 'done', attachments: [], sentAt: new Date(T - 60_000).toISOString(), readAt: null },
        { seq: 2, id: 'msg_2', from: 'agent_kai', to: 'agent_wren', text: 'yours', attachments: [], sentAt: new Date(T - 30_000).toISOString(), readAt: null },
    ];
    const names: Record<string, string> = { human: 'you', agent_kai: 'kai', agent_wren: 'wren' };
    const props: InboxFlyoutViewProps = {
        threads: inboxThreads(mail, (p) => names[p] ?? p), peers: [], thread: null, openKey: null, query: '', filter: 'all', now: T, uncollected: 0, unread: 1, draft: '',
        onQuery: noop, onFilter: noop, onOpenThread: noop, onLoadOlder: noop, onDraft: noop, onSend: noop, onDownload: noop, onMarkAllRead: noop, onDelete: noop, onClose: noop,
    };
    // The view is hook-free (tests press it from its element tree): the flyout hands it the window's agent colours.
    const html = renderToStaticMarkup(
        <Drawer open onClose={noop} attach="container"><InboxFlyoutView {...props} agentColors={{ agent_kai: TEAL, agent_wren: PINK }} /></Drawer>,
    );

    it('each agent in a thread row carries its own workspace\'s colour, beside its name', () => {
        const yours = html.slice(html.indexOf(`data-inbox-thread="${pairKey('human', 'agent_kai')}"`));
        expect(yours).toMatch(/^[^]*?data-workspace-color="#0891b2"[^]*?kai/);
        const between = html.slice(html.indexOf(`data-inbox-thread="${pairKey('agent_kai', 'agent_wren')}"`));
        expect(between.slice(0, between.indexOf('</button>'))).toContain('data-workspace-color="#0891b2"');
        expect(between.slice(0, between.indexOf('</button>'))).toContain('data-workspace-color="#db2777"');
    });
});

describe('a question, an approval and a toast name their source\'s colour', () => {
    const base = { agentId: 'agent_kai', agentName: 'kai', workspaceId: 'tynn', workspaceName: 'Tynn', blocking: false, priority: 'normal', at: 1, forwardedFrom: null };

    it('the question window', () => {
        const item = { ...base, id: 'q1', source: 'agent-question', title: 'Pick', workspaceColor: TEAL,
            answer: { kind: 'form', fields: 1, questions: [{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } } as unknown as DeckItem;
        const html = renderToStaticMarkup(<QuestionApp view={{ item, waiting: 0 }} sending={false} refusal={null} onAnswer={noop} onLater={noop} onDismiss={noop} />);
        expect(marked(html)).toBe(true);
        expect(html).toMatch(/data-workspace-color="#0891b2"[\s\S]*Tynn/);
    });

    it('the approval toast', () => {
        const item = { ...base, id: 'appr_1', source: 'agent-question', title: 'Start a site', workspaceColor: TEAL,
            answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] } } as unknown as DeckItem;
        const view = toastView(toastReducer(EMPTY_TOASTS, { kind: 'items', items: [item], dnd: false }), [item]);
        const html = renderToStaticMarkup(<ApprovalToastStack view={view} onAnswer={noop} onLater={noop} onFront={noop} onEngage={noop} />);
        expect(marked(html)).toBe(true);
        expect(html).toMatch(/data-approval-toast-workspace=""[\s\S]*Tynn/);
    });

    it('an alert toast', () => {
        const html = renderToStaticMarkup(<AlertToasts toasts={[{ id: 't1', title: 'kai@tynn', body: 'Finished: done', color: TEAL }]} onDismiss={noop} />);
        expect(marked(html)).toBe(true);
        expect(html).toContain('kai@tynn');
        expect(renderToStaticMarkup(<AlertToasts toasts={[{ id: 't1', title: 'genie@system', body: 'x' }]} onDismiss={noop} />)).not.toContain('data-workspace-color');
    });
});

describe('the Dashboard\'s workspace rows', () => {
    const row = (id: string, workspaceId: string): AgentRow => ({
        id, name: id, workspaceId, state: 'working', provider: 'codex', fidelity: 'declared', duration: null,
        ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
        collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
    });
    it('each workspace\'s header is edged in its colour, beside its name', () => {
        const html = renderToStaticMarkup(<Dashboard rows={[row('kai', 'tynn'), row('wren', 'fancy')]} genie={null} onOpenAgent={noop} onAddAgent={noop}
            workspaces={[{ id: 'tynn', name: 'Tynn', path: '/w/tynn', color: TEAL }, { id: 'fancy', name: 'Fancy', path: '/w/fancy', color: PINK }]} />);
        expect(html).toMatch(/data-workspace-head="tynn"[^>]*data-workspace-color="#0891b2"[\s\S]*Tynn/);
        expect(html).toMatch(/data-workspace-head="fancy"[^>]*data-workspace-color="#db2777"[\s\S]*Fancy/);
    });
});

describe('workspaceColorMap — what the window knows, from the snapshot', () => {
    it('each workspace\'s colour, and each agent\'s by its workspace', () => {
        const map = workspaceColorMap({
            workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true, color: TEAL }, { id: 'bare', path: '/w/bare', agentsKnown: true }],
            agents: [{ id: 'kai', workspaceId: 'tynn' }, { id: 'lone', workspaceId: 'bare' }] as never,
        });
        expect(map).toEqual({ workspaces: { tynn: TEAL }, agents: { kai: TEAL } });
    });
});

// ---- Settings: the palette and the custom colour ------------------------------------------------------------------------

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const p = node.props as Props;
    if (match(p)) out.push(p);
    findAll(p.children, match, out);
    return out;
}

describe('the workspace\'s Settings: palette plus a custom colour', () => {
    it('offers every palette colour, the current one pressed, and a custom picker holding the current colour', () => {
        const html = renderToStaticMarkup(<WorkspaceColorPicker current={TEAL} onSet={noop} />);
        for (const c of WORKSPACE_PALETTE) expect(html).toContain(`data-ws-color-option="${c}"`);
        expect(html).toMatch(/data-ws-color-option="#0891b2"[^>]*aria-pressed="true"/);
        expect(html).toMatch(/type="color"[^>]*value="#0891b2"|value="#0891b2"[^>]*type="color"/);
    });

    it('a palette click and a custom pick both hand the colour to onSet', () => {
        const set: string[] = [];
        const tree = WorkspaceColorPicker({ current: TEAL, onSet: (c) => set.push(c) });
        const pink = findAll(tree, (p) => p['data-ws-color-option'] === PINK)[0]!;
        (pink.onClick as () => void)();
        const custom = findAll(tree, (p) => p.type === 'color')[0]!;
        (custom.onChange as (e: { target: { value: string } }) => void)({ target: { value: '#123456' } });
        expect(set).toEqual([PINK, '#123456']);
    });

    it('a custom colour hard to see on a theme says which — in few words; a palette colour says nothing', () => {
        expect(renderToStaticMarkup(<WorkspaceColorPicker current="#fde047" onSet={noop} />)).toMatch(/data-ws-color-contrast="light"[^>]*>Faint on light</);
        expect(renderToStaticMarkup(<WorkspaceColorPicker current="#1e1b4b" onSet={noop} />)).toMatch(/data-ws-color-contrast="dark"[^>]*>Faint on dark</);
        expect(renderToStaticMarkup(<WorkspaceColorPicker current={TEAL} onSet={noop} />)).not.toContain('data-ws-color-contrast');
    });
});
