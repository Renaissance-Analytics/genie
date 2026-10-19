import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dockHolder, pinPanel, routeAfterPin } from '../src/core/dock.js';
import { chatAction } from '../src/core/keys.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { type ChatThread } from '../src/renderer/components/ChatFlyout.js';
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

describe('keys: a docked chat stays until closed', () => {
    it('Esc does not close it; A / D still answer the approval it holds', () => {
        const press = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false });
        expect(chatAction(press('Escape'), { open: true })).toBeNull();
        expect(chatAction(press('a'), { open: true, approval: true })).toBe('allow');
        expect(chatAction(press('d'), { open: true, approval: true })).toBe('deny');
    });
});
