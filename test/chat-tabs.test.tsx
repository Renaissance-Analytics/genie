import { CHAT_DOCK_DEFAULT_WIDTH } from '../src/core/dock.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatThreads, rememberThread } from '../src/core/chat-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { CHAT_STRIP_WIDTH, DOCK_WIDTH, dockReserve } from '../src/core/dock.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';

/**
 * THE CHAT IS ALWAYS THERE, AS TABS (the owner, using beta.19: "The chat should be a flyout that is always present with
 * chat tabs or it can be pinned (refer to the mockups)"). The board's flyout heads each conversation as a THREAD tab —
 * its state dot and unread count, genie always last, across workspaces (`Chat Flyout`: atlas · lark · rook · genie).
 * Closed, the chat is a strip on the right edge with those tabs, on every surface, reserving its width so nothing sits
 * under it; a tab opens that conversation in the flyout. Pinned, the flyout holds the 380px gutter instead.
 */
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
const agents: AgentRow[] = [
    row({ id: 'a_atlas', name: 'atlas', state: 'working' }),
    row({ id: 'a_wren', name: 'wren', state: 'waiting' }),
    row({ id: 'a_lark', name: 'lark', workspaceId: 'moic', state: 'broken' }),
    row({ id: 'a_rook', name: 'rook', workspaceId: 'moic', state: 'idle' }),
];

describe('the threads', () => {
    it('the conversations you opened, newest first; then whoever waits on you; genie always last', () => {
        expect(chatThreads(agents, ['a_lark', 'a_atlas'], 'a_atlas').map((t) => [t.agentId, t.name, t.state, t.active])).toEqual([
            ['a_lark', 'lark', 'broken', false],
            ['a_atlas', 'atlas', 'working', true],
            ['a_wren', 'wren', 'waiting', false],
            ['genie', 'genie', null, false],
        ]);
    });

    it('an agent no longer on the board drops out; genie alone when nothing else is open', () => {
        expect(chatThreads(agents, ['gone', 'a_rook'], null).map((t) => t.agentId)).toEqual(['a_rook', 'a_wren', 'genie']);
        expect(chatThreads([], [], null).map((t) => t.agentId)).toEqual(['genie']);
    });

    it('remembering a thread puts it first, once, and keeps eight', () => {
        expect(rememberThread(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
        expect(rememberThread(['1', '2', '3', '4', '5', '6', '7', '8'], '9')).toEqual(['9', '1', '2', '3', '4', '5', '6', '7']);
    });
});

describe('the strip', () => {
    it('reserves its own width when nothing is pinned, the dock\'s when something is', () => {
        expect(dockReserve(null)).toBe(CHAT_STRIP_WIDTH);
        expect(dockReserve('chat')).toBe(CHAT_DOCK_DEFAULT_WIDTH); // a pinned chat: its own width (Tynn #798)
        expect(dockReserve('files')).toBe(DOCK_WIDTH);
    });

    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, agents, workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'moic', path: '/w/moic', agentsKnown: true }] };
    function render(over: Partial<Parameters<typeof Shell>[0]> = {}): string {
        return renderToStaticMarkup(
            <Shell
                route="genie://dashboard?group=workspace"
                snapshot={snapshot}
                servable={['dashboard', 'deck', 'agent', 'workspace']}
                agentDetail={null}
                agentResolved={false}
                selectedRowId={null}
                chatThread={null}
                chatThreads={chatThreads(agents, ['a_atlas'], null)}
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
    }

    it('is on the surface with nothing open: a tab per thread, each a door to its conversation', () => {
        const html = render({});
        expect(html).toContain(`data-dock-reserve="${CHAT_STRIP_WIDTH}"`);
        expect(html).toMatch(/data-chat-strip=""[\s\S]*data-chat-tab="a_atlas"[\s\S]*data-chat-tab="a_wren"[\s\S]*data-chat-tab="genie"/);
        expect(html).toMatch(/data-chat-tab="a_wren"[^>]*data-state="waiting"/);
    });

    it('gives way to the open chat, which is docked (positive control: the same render, the chat open)', () => {
        const html = render({ route: 'genie://dashboard?chat=a_atlas', chatThread: { agentId: 'a_atlas', name: 'atlas', fidelity: 'declared', unread: null, messages: [] } });
        expect(html).not.toContain('data-chat-strip');
        expect(html).toContain(`data-dock-reserve="${CHAT_DOCK_DEFAULT_WIDTH}"`);
        // The open chat heads the conversation with the same tabs, genie last, the subject active.
        expect(html).toMatch(/data-chat-thread-chip="a_atlas" data-active="true"[\s\S]*data-chat-thread-chip="genie"/);
    });
});
