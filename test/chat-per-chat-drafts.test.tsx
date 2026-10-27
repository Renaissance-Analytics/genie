import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../src/core/prompt-content.js';

/**
 * ONE DRAFT PER CHAT (genie#1261). The owner, beta.47: text half-typed in one agent's chat followed him into another
 * workspace's or agent's chat. The flyout drew ONE react-fancy `PromptInput`, unkeyed, so React kept that one instance —
 * and the text in its state — whichever agent the chat was showing.
 *
 * Genie 1 never had the bug, because each agent's draft lived in that agent's own TUI input box, and every terminal
 * panel was ONE instance keyed by its id, kept mounted-hidden off screen (v0.7.0-beta.342
 * `renderer/lib/terminal-grid-layout.ts:150-157`, `renderer/components/Terminal/Terminal.tsx:38-45`). Genie 2 does the
 * same for the composer: one `PromptInput` per chat, keyed by the chat's agent, the ones not on screen kept mounted and
 * hidden. `PromptInput` has no value/reset API (react-fancy 5.59.0: `text` is internal `useState("")`), so keeping the
 * instance is the ONLY way its text, paste pills, attachments and caret survive — and the only Genie-side way.
 *
 * No DOM (house rule, docs/decisions.md D3): React's reconciliation is asserted where it is decided — the composer list's
 * KEYS and slots across a switch — and the markup through Genie's own handles. Typing itself is react-fancy's state and
 * is not re-proved here.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
type ChatThread = import('../src/renderer/components/ChatFlyout.js').ChatThread;
// Imported where used: on origin/main neither exists, and a top-level import would fail every test for "not found".
const chatDrafts = () => import('../src/core/chat-drafts.js');
const flyout = () => import('../src/renderer/components/ChatFlyout.js') as Promise<Record<string, unknown>>;

const count = (html: string, needle: string): number => html.split(needle).length - 1;
const thread = (agentId: string, name: string): ChatThread => ({ agentId, name, fidelity: 'declared', unread: null, messages: [] });
const A = thread('a_lark', 'lark');
const B = thread('a_wren', 'wren');

describe('the chats whose drafts are kept (core/chat-drafts.ts)', () => {
    it('A, then B: both kept, in the order opened — A is not dropped for B', async () => {
        const { keepChat } = await chatDrafts();
        const afterA = keepChat([], 'a_lark');
        expect(afterA).toEqual(['a_lark']);
        expect(keepChat(afterA, 'a_wren')).toEqual(['a_lark', 'a_wren']);
    });

    it('back to A: the SAME list (no re-render loop, no slot moved — A keeps its instance)', async () => {
        const { keepChat } = await chatDrafts();
        const both = ['a_lark', 'a_wren'];
        expect(keepChat(both, 'a_lark')).toBe(both);
        expect(keepChat(both, 'a_wren')).toBe(both);
    });

    it('no composer on screen (a blocked chat) keeps what is there and adds nothing', async () => {
        const { keepChat } = await chatDrafts();
        const both = ['a_lark', 'a_wren'];
        expect(keepChat(both, null)).toBe(both);
        expect(keepChat([], null)).toEqual([]);
    });
});

describe('one composer per chat, keyed by its agent (ChatComposers)', () => {
    type Composers = (p: { chats: readonly string[]; active: string | null; children: (chat: string) => ReactElement }) => ReactElement;
    const composers = async (): Promise<Composers> => (await flyout()).ChatComposers as Composers;
    const slots = (el: ReactElement) => (el.props as { children: ReactElement[] }).children.map((c) => {
        expect(isValidElement(c)).toBe(true);
        return { key: c.key, type: c.type, chat: (c.props as Record<string, unknown>)['data-chat-draft'], hidden: (c.props as Record<string, unknown>).hidden === true, composer: 'data-chat-composer' in (c.props as object) };
    });

    it('typing in A then switching to B: the same two instances in the same slots, keyed by agent — B is its own, A is kept', async () => {
        const ChatComposers = await composers();
        const box = (chat: string) => <span data-box={chat} />;
        const onA = slots(ChatComposers({ chats: ['a_lark', 'a_wren'], active: 'a_lark', children: box }));
        const onB = slots(ChatComposers({ chats: ['a_lark', 'a_wren'], active: 'a_wren', children: box }));
        // React reconciles by key + type + slot: identical here, so the switch moves no instance — A's state stays A's.
        expect(onB.map((s) => [s.key, s.type])).toEqual(onA.map((s) => [s.key, s.type]));
        expect(onA.map((s) => s.key)).toEqual(['a_lark', 'a_wren']);
        expect(onA.map((s) => s.chat)).toEqual(['a_lark', 'a_wren']);
        // On A: A shows, B hidden. On B: B shows, A hidden — mounted, so back on A its draft is there.
        expect(onA.map((s) => [s.hidden, s.composer])).toEqual([[false, true], [true, false]]);
        expect(onB.map((s) => [s.hidden, s.composer])).toEqual([[true, false], [false, true]]);
    });

    it('a HIDDEN draft is not drawn again when the chat on screen updates — only the composer on screen is (genie#1273)', async () => {
        /*
         * The flyout re-renders on every event of the agent on screen (its thread grows), and builds a NEW render function
         * for the composers each time — the `commands`, meter and placeholder of the chat on screen. Every kept composer
         * was a direct child of that render, so each event drew EVERY kept PromptInput again: the renderer's per-event
         * cost grew with the number of chats opened in the session (the owner: "severe UI lag" with many agents).
         * React skips a child only behind `memo`, by its comparator — so that is where it is asserted: the comparator's
         * answer for each slot across two renders of the flyout. No memo at all means React draws it again.
         */
        const ChatComposers = await composers();
        const drawn = (active: string | null) => ChatComposers({ chats: ['a_lark', 'a_wren', 'a_kite'], active, children: (c) => <span data-box={c} /> });
        const inner = (el: ReactElement) => (el.props as { children: ReactElement[] }).children.map((slot) => (slot.props as { children: ReactElement }).children);
        const redrawn = (before: ReactElement, after: ReactElement) => inner(before).map((prev, i) => {
            const next = inner(after)[i]!;
            const type = prev.type as { compare?: ((a: unknown, b: unknown) => boolean) | null };
            if (prev.type !== next.type || typeof type !== 'object' || typeof type.compare !== 'function') return true;
            return !type.compare(prev.props, next.props);
        });
        // An event on a_kite's chat: the same chats, a new render function. Only a_kite's composer is drawn again.
        expect(redrawn(drawn('a_kite'), drawn('a_kite'))).toEqual([false, false, true]);
        // CONTROL — switching to a_lark draws a_lark's composer again (its props were frozen while hidden), and not a_wren's.
        expect(redrawn(drawn('a_kite'), drawn('a_lark'))).toEqual([true, false, false]);
    });

    it('no chat active (blocked): every kept composer hidden, none carries Genie’s composer handle', async () => {
        const ChatComposers = await composers();
        const s = slots(ChatComposers({ chats: ['a_lark', 'a_wren'], active: null, children: (c) => <span data-box={c} /> }));
        expect(s.map((x) => [x.hidden, x.composer])).toEqual([[true, false], [true, false]]);
    });

    it('two kept chats in markup: two editors, ONE [data-chat-composer] — the visible one — so the smoke and ⌘L find the right box', async () => {
        const ChatComposers = await composers();
        const html = renderToStaticMarkup(ChatComposers({ chats: ['a_lark', 'a_wren'], active: 'a_wren', children: (c) => <div contentEditable="true" role="textbox" data-box={c} /> }));
        expect(count(html, 'data-chat-draft=')).toBe(2);
        expect(count(html, 'data-chat-composer=""')).toBe(1);
        const visible = html.slice(html.indexOf('data-chat-composer=""'));
        expect(visible).toContain('data-box="a_wren"');
        expect(visible).not.toContain('data-box="a_lark"');
    });
});

describe('the flyout draws its composer through it', () => {
    it('the composer on screen is the chat’s OWN: wrapped by its agent, Genie’s handle on it', () => {
        seen.length = 0;
        const html = renderToStaticMarkup(<ChatFlyout thread={A} onSend={() => {}} onClose={() => {}} />);
        expect(count(html, 'data-chat-draft="a_lark"')).toBe(1);
        expect(html).toMatch(/data-chat-draft="a_lark"[^>]*data-chat-composer=""|data-chat-composer=""[^>]*data-chat-draft="a_lark"/);
        expect(seen).toHaveLength(1);
    });

    it('B’s chat opened fresh draws B’s composer, not one carrying another chat’s name', () => {
        const html = renderToStaticMarkup(<ChatFlyout thread={B} onSend={() => {}} onClose={() => {}} />);
        expect(count(html, 'data-chat-draft="a_wren"')).toBe(1);
        expect(count(html, 'data-chat-draft="a_lark"')).toBe(0);
    });

    it('sending from a chat’s composer names THAT chat’s agent, so its send clears its own box and goes to its own agent', async () => {
        seen.length = 0;
        const sent: Array<[string, string | undefined]> = [];
        renderToStaticMarkup(<ChatFlyout thread={A} onSend={(text: string, _files?: readonly Attachment[], agentId?: string) => { sent.push([text, agentId]); }} onClose={() => {}} />);
        (seen[0]!.onSubmit as (text: string, picked: unknown[]) => void)('hello lark', []);
        await vi.waitFor(() => expect(sent).toEqual([['hello lark', 'a_lark']]));
    });

    it('CONTROL: a blocked flyout draws no composer for a chat never typed in', () => {
        seen.length = 0;
        const html = renderToStaticMarkup(<ChatFlyout thread={A} scope={{ kind: 'blocked', reason: 'No agent here to message.' }} onSend={() => {}} onClose={() => {}} />);
        expect(count(html, 'data-chat-blocked=""')).toBe(1);
        expect(count(html, 'data-chat-draft=')).toBe(0);
        expect(seen).toHaveLength(0);
    });
});
