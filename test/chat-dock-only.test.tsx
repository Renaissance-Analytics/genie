import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHAT_DOCK_DEFAULT_WIDTH, CHAT_STRIP_WIDTH, DOCK_WIDTH, dockHolder, pinPanel, routeAfterPin } from '../src/core/dock.js';
import { chatAction } from '../src/core/keys.js';
import { horizontalWheel } from '../src/core/wheel.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE PINNED CHAT IS THE ONLY CHAT (the owner, 2026-10-17: "let's get rid of the chat flyout and make the pinned chat be
 * the only chat ux. make the chat tabs row scroll horizontal with the mouse wheel. Make sure it's not cutting off other
 * ui either").
 *
 * An open chat always sits in the dock, its width reserved, nothing overlaid: no overlay, no pin to toggle, a close
 * button always. With the chat closed the strip of chat tabs keeps the edge. A pinned file panel is not thrown away
 * when a chat opens over it — it stays mounted, hidden, unsaved edits and all, and is back the moment the chat closes.
 */
const snapshot: GenieSnapshot = {
    ...EMPTY_SNAPSHOT,
    agents: [],
    workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }],
    deckItems: [],
    signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
    workstation: { name: 'alphar', healthy: true },
};
const THREAD: ChatThread = { agentId: 'kai', name: 'kai', fidelity: 'declared', unread: null, messages: [] };

function shell(over: Partial<Parameters<typeof Shell>[0]> = {}): string {
    return renderToStaticMarkup(
        <Shell
            route="genie://dashboard?group=workspace"
            snapshot={snapshot}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={null}
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

describe('who holds the dock', () => {
    it('an open chat holds it, over a pinned file panel; closed, the pin is back; nothing open, nothing pinned: nobody', () => {
        expect(dockHolder(null, true)).toBe('chat');
        expect(dockHolder('files', true)).toBe('chat');
        expect(dockHolder('files', false)).toBe('files');
        expect(dockHolder(null, false)).toBeNull();
    });

    it('pinning the file panel while a chat is open closes the chat (one slot), and says so', () => {
        const outcome = pinPanel(dockHolder(null, true), 'files', false);
        expect(outcome).toEqual({ pinned: 'files', replaced: 'chat', refused: null });
        expect(routeAfterPin('genie://workspace/tynn?chat=kai', outcome)).toBe('genie://workspace/tynn');
        expect(routeAfterPin('genie://agent/kai?tab=stream&chat=kai', outcome)).toBe('genie://agent/kai?tab=stream');
        // CONTROL: a pin that displaced nothing leaves the route alone.
        expect(routeAfterPin('genie://workspace/tynn?panel=files', pinPanel(null, 'files', false))).toBe('genie://workspace/tynn?panel=files');
    });
});

describe('the chat, open: always docked', () => {
    it('in the dock frame, its width reserved, no overlay, no pin, a close button; the strip gives way', () => {
        const html = shell({ route: 'genie://dashboard?chat=kai', chatThread: THREAD });
        expect(html).toContain('data-chat="pinned"');
        expect(html).toContain('data-dock-frame="chat"');
        expect(html).toContain(`data-dock-reserve="${CHAT_DOCK_DEFAULT_WIDTH}"`);
        expect(html).not.toContain('data-chat="overlay"');
        expect(html).not.toContain('data-chat-pin');
        expect(html).toContain('aria-label="Close chat"');
        expect(html).not.toContain('data-chat-strip');
    });

    it('CONTROL — closed: the strip of chat tabs, and only its reserve', () => {
        const html = shell();
        expect(html).toContain('data-chat-strip');
        expect(html).not.toContain('data-chat=');
        expect(html).toContain(`data-dock-reserve="${CHAT_STRIP_WIDTH}"`);
    });

    it('over a pinned file panel: the chat holds the dock; the panel stays MOUNTED, hidden (its unsaved edits kept)', () => {
        const html = shell({ route: 'genie://dashboard?chat=kai', chatThread: THREAD, pinned: 'files', filesWorkspaceId: 'tynn' });
        expect(html).toContain(`data-dock-reserve="${CHAT_DOCK_DEFAULT_WIDTH}"`);
        expect(html).toMatch(/<aside[^>]*data-dock="files"[^>]*hidden=""/);
        expect(html).toContain('data-files-panel="tynn"');
        // CONTROL: the chat closed, the same pin is on screen, not hidden, with its own reserve.
        const back = shell({ pinned: 'files', filesWorkspaceId: 'tynn' });
        expect(back).toMatch(/<aside[^>]*data-dock="files"/);
        expect(back).not.toMatch(/<aside[^>]*data-dock="files"[^>]*hidden=""/);
        expect(back).toContain(`data-dock-reserve="${DOCK_WIDTH}"`);
    });
});

describe('keys: a docked chat stays until closed', () => {
    it('Esc does not close it; A / D still answer the approval it holds', () => {
        const press = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false });
        expect(chatAction(press('Escape'), { open: true })).toBeNull();
        expect(chatAction(press('a'), { open: true, approval: true })).toBe('allow');
        expect(chatAction(press('d'), { open: true, approval: true })).toBe('deny');
    });
});

describe('the chat tabs row', () => {
    it('a mouse wheel scrolls it sideways: lines and pixels both; a trackpad’s own sideways swipe is left to the browser', () => {
        expect(horizontalWheel({ deltaX: 0, deltaY: 120, deltaMode: 0 })).toBe(120);
        expect(horizontalWheel({ deltaX: 0, deltaY: -3, deltaMode: 1 })).toBe(-48);
        expect(horizontalWheel({ deltaX: 30, deltaY: 4, deltaMode: 0 })).toBe(0);
        expect(horizontalWheel({ deltaX: 0, deltaY: 0, deltaMode: 0 })).toBe(0);
    });

    it('takes no more than the panel’s width and draws no scrollbar over its chips', () => {
        const chips = ['prism', 'tynn', 'moic', 'fancy', 'tribeshare', 'impactium'].map((n) => ({ agentId: n, name: n, state: 'idle' as const, fidelity: 'declared' as const, active: n === 'prism', unread: null }));
        const html = renderToStaticMarkup(<ChatFlyout thread={{ ...THREAD, chips }} onSend={() => {}} onClose={() => {}} onPickThread={() => {}} />);
        const row = html.match(/<div[^>]*data-chat-threads=""[^>]*>/)?.[0] ?? '';
        expect(row).not.toBe('');
        expect(row).toContain('min-w-0');
        expect(row).toContain('[scrollbar-width:none]');
        expect((html.match(/data-chat-thread-chip=/g) ?? []).length).toBe(6);
    });
});
