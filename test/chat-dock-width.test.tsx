import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHAT_DOCK_DEFAULT, CHAT_DOCK_KEEP, CHAT_DOCK_MIN, clampChatDockWidth, readChatDockWidth, writeChatDockWidth } from '../src/core/chat-width.js';
import { DOCK_WIDTH, dockReserve } from '../src/core/dock.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE PINNED CHAT IS WIDE ENOUGH, AND YOURS TO WIDEN (Tynn #798). The owner, 2026-10-17: "expanding the chat panel when
 * pinned. It's too thin now." Pinned, the chat was the dock's 380px, fixed. It is now wider by default, its edge drags
 * while pinned too, and the width is remembered — on its own, apart from the unpinned flyout's. The content row's
 * reserve is the SAME number the panel is sized by (core/dock.ts: two numbers is an overlap), so it follows the drag.
 */
function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('the pinned width', () => {
    it('defaults wider than the old 380, never narrower than it, and is remembered on its own', () => {
        expect(CHAT_DOCK_DEFAULT).toBeGreaterThanOrEqual(480);
        expect(CHAT_DOCK_MIN).toBe(DOCK_WIDTH);
        const s = memory();
        expect(readChatDockWidth(s)).toBe(CHAT_DOCK_DEFAULT);
        writeChatDockWidth(s, 640);
        expect(readChatDockWidth(s)).toBe(640);
        expect([...s.data.keys()]).toEqual(['genie.chat.dockWidth']); // not the unpinned flyout's key
        s.setItem('genie.chat.dockWidth', 'nonsense');
        expect(readChatDockWidth(s)).toBe(CHAT_DOCK_DEFAULT);
    });

    it('a drag is clamped so the view beside it stays usable', () => {
        expect(clampChatDockWidth(200, 1600)).toBe(CHAT_DOCK_MIN);
        expect(clampChatDockWidth(5000, 1600)).toBe(1600 - CHAT_DOCK_KEEP);
        expect(clampChatDockWidth(700, 1600)).toBe(700);
    });

    it('the reserve IS the chat’s width when the chat is pinned; files/lists keep the dock’s; nothing pinned keeps the strip (CONTROLS)', () => {
        expect(dockReserve('chat', 640)).toBe(640);
        expect(dockReserve('chat')).toBe(CHAT_DOCK_DEFAULT);
        expect(dockReserve('files', 640)).toBe(DOCK_WIDTH);
        expect(dockReserve(null, 640)).toBe(32);
    });
});

describe('the panel', () => {
    const thread = { agentId: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', context: null, messages: [], chips: [] } as unknown as ChatThread;
    it('sized by the width it is given, and its edge drags', () => {
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} widthStorage={null} dockWidth={640} onDockWidth={() => {}} />);
        expect(html).toMatch(/style="width:640px"/);
        expect(html).toContain('data-chat-resize');
    });
});
