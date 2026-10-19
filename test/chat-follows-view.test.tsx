import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { carryChat, parseRoute } from '../src/core/route.js';
import { rememberThread } from '../src/core/chat-view.js';
import { CHAT_DOCK_DEFAULT_WIDTH, CHAT_STRIP_WIDTH, DOCK_WIDTH, dockReserve } from '../src/core/dock.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';

/**
 * THE CHAT FOLLOWS THE VIEW; THERE ARE NO CHAT TABS (the owner, 2026-10-18: "get rid of the chat tabs completely because
 * we should be switching from workspace to workspace and then the workspaces have agent tabs already. Any view that is
 * not a workspace view shows the genie agent chat").
 *
 * - an AGENT's view: the chat is that agent (a workspace's agent tabs are how you pick one);
 * - a WORKSPACE's view: an agent of that workspace — the one already in the chat if it is there, else the one you last
 *   chatted with there, else its first;
 * - ANY OTHER view (Dashboard, Deck, Settings, the feature surfaces): Genie.
 * - no strip of tabs on the edge and no chips in the chat: one button opens the chat when it is closed, already on the
 *   agent the view says.
 */
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: 'ws_alpha', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
// alpha: atlas, wren. beta: lark, rook. genie: the OS agent, in no project.
const agents: AgentRow[] = [
    row({ id: 'a_atlas', name: 'atlas' }),
    row({ id: 'a_wren', name: 'wren', state: 'waiting' }),
    row({ id: 'a_lark', name: 'lark', workspaceId: 'ws_beta' }),
    row({ id: 'a_rook', name: 'rook', workspaceId: 'ws_beta' }),
    row({ id: 'a_genie', name: 'genie', workspaceId: '__genie__' }),
];
const chatOf = (r: string): string | null => parseRoute(r).chat;
const onAtlas = parseRoute('genie://agent/a_atlas?tab=stream&chat=a_atlas');

describe('the chat follows the view', () => {
    it('an agent’s view: that agent — in its own workspace too, and Genie’s own view is Genie', () => {
        expect(chatOf(carryChat('genie://agent/a_wren?tab=stream', onAtlas, agents, []))).toBe('a_wren');
        expect(chatOf(carryChat('genie://agent/a_rook?tab=stream', onAtlas, agents, []))).toBe('a_rook');
        expect(chatOf(carryChat('genie://agent/a_genie?tab=stream', onAtlas, agents, []))).toBe('a_genie');
    });

    it('a workspace’s view: the agent already in the chat if it is there, else the last chatted with there, else its first', () => {
        expect(chatOf(carryChat('genie://workspace/ws_alpha', onAtlas, agents, []))).toBe('a_atlas');
        expect(chatOf(carryChat('genie://workspace/ws_beta', onAtlas, agents, ['a_wren', 'a_rook']))).toBe('a_rook');
        expect(chatOf(carryChat('genie://workspace/ws_beta', onAtlas, agents, []))).toBe('a_lark');
        // From Genie's chat into a workspace: that workspace's agent — Genie is not kept over a workspace's agents.
        expect(chatOf(carryChat('genie://workspace/ws_beta', parseRoute('genie://deck?chat=a_genie'), agents, []))).toBe('a_lark');
    });

    it('any other view: Genie (COUNTED: every non-workspace surface)', () => {
        const surfaces = ['genie://dashboard?group=workspace', 'genie://deck', 'genie://settings', 'genie://hosting', 'genie://toolchain', 'genie://knowledge'];
        expect(surfaces.map((s) => chatOf(carryChat(s, onAtlas, agents, [])))).toEqual(surfaces.map(() => 'a_genie'));
    });

    it('pinned stays pinned; a closed chat stays closed', () => {
        expect(carryChat('genie://deck', parseRoute('genie://agent/a_atlas?tab=stream&chat=a_atlas&pin=right'), agents, [])).toBe('genie://deck?chat=a_genie&pin=right');
        expect(carryChat('genie://deck', parseRoute('genie://agent/a_atlas?tab=stream'), agents, [])).toBe('genie://deck');
    });

    it('CONTROL: a route that names its own chat is left alone', () => {
        expect(carryChat('genie://deck?chat=a_atlas', onAtlas, agents, [])).toBe('genie://deck?chat=a_atlas');
    });
});

describe('what the workspace chat is chosen from', () => {
    it('remembering a conversation puts it first, once, and keeps eight', () => {
        expect(rememberThread(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
        expect(rememberThread(['1', '2', '3', '4', '5', '6', '7', '8'], '9')).toEqual(['9', '1', '2', '3', '4', '5', '6', '7']);
    });

    it('the edge keeps the open button’s width when nothing is docked; the dock’s when something is', () => {
        expect(dockReserve(null)).toBe(CHAT_STRIP_WIDTH);
        expect(dockReserve('chat')).toBe(CHAT_DOCK_DEFAULT_WIDTH);
        expect(dockReserve('files')).toBe(DOCK_WIDTH);
    });
});

describe('no chat tabs', () => {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, agents, workspaces: [{ id: 'ws_alpha', path: '/w/alpha', agentsKnown: true }, { id: 'ws_beta', path: '/w/beta', agentsKnown: true }] };
    const render = (over: Partial<Parameters<typeof Shell>[0]> = {}): string =>
        renderToStaticMarkup(
            <Shell
                route="genie://dashboard?group=workspace"
                snapshot={snapshot}
                servable={['dashboard', 'deck', 'agent', 'workspace']}
                agentDetail={null}
                agentResolved={false}
                selectedRowId={null}
                chatThread={null}
                openedThreads={['a_atlas', 'a_wren']}
                pinned={null}
                files={NO_FILES}
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
                {...over}
            />,
        );

    it('open: no chips in the chat — and no open button (positive control: the chat IS drawn)', () => {
        const html = render({ route: 'genie://dashboard?chat=a_genie', chatThread: { agentId: 'a_genie', name: 'genie', fidelity: 'declared', unread: null, messages: [] } });
        expect(html).toContain('data-chat="pinned"');
        expect(html).not.toContain('data-chat-threads');
        expect(html).not.toContain('data-chat-thread-chip');
        expect(html).not.toContain('data-action="open-chat"');
    });
});
