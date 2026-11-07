// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * JUMP TO LATEST (the owner, 2026-11-04, Tynn task #944): "a jump to latest button" in the agent chat, there whenever
 * the chat is scrolled away from the bottom, that takes you to the newest message and resumes following live; gone at
 * the bottom. It must not take focus from the composer and must not move the layout.
 *
 * It keeps the Following Live rule (core/chat-window.ts, the owner 2026-10-22): following = at the end, and the jump is
 * the door back to it, the chat's counterpart of the Stream's `Parked` pill (components/Stream.tsx).
 *
 * happy-dom has no layout (docs/decisions.md D3), so the scroller's geometry is given to it: `scrollHeight` and
 * `clientHeight` are set on the element, `scrollTop` is moved, and a `scroll` event is dispatched, as a wheel would.
 * Proven here: the button follows the scroll position, and its click puts the scroller at its end. Not proven here:
 * the pixels of a real window.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, who: 'agent' as const, from: 'atlas', text: `reply ${i}`, delivered: true, at: null }));
const thread: ChatThread = { agentId: 'agent_a', name: 'atlas', fidelity: 'declared', unread: null, messages: many };

const scroller = () => host.querySelector<HTMLDivElement>('[data-chat-scroll]')!;
const jump = () => host.querySelector<HTMLButtonElement>('[data-chat-jump]');
/** The scroller's geometry, as a real layout would report it: 4,000px of thread in a 600px box. */
const HEIGHT = 4000;
const BOX = 600;
const mount = () => {
    act(() => root.render(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} widthStorage={null} />));
    const el = scroller();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => BOX });
    return el;
};
const scrollTo = (el: HTMLElement, top: number) => act(() => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
});

describe('Jump to latest', () => {
    it('CONTROL: at the bottom there is no jump button (and the chat did render: 40 messages)', () => {
        const el = mount();
        scrollTo(el, HEIGHT - BOX);
        expect(host.querySelectorAll('[data-chat-message]')).toHaveLength(40);
        expect(jump()).toBeNull();
    });

    it('scrolled away from the bottom, the button appears: a react-fancy Button reading "Jump to latest"', () => {
        const el = mount();
        scrollTo(el, 1200);
        const b = jump();
        expect(b).not.toBeNull();
        expect(b!.tagName).toBe('BUTTON');
        expect(b!.hasAttribute('data-react-fancy-button')).toBe(true);
        expect(b!.textContent).toContain('Jump to latest');
    });

    it('clicking it scrolls to the end, and then it is gone; back at the bottom by hand it is gone too', () => {
        const el = mount();
        scrollTo(el, 1200);
        act(() => jump()!.click());
        expect(el.scrollTop).toBeGreaterThanOrEqual(HEIGHT - BOX);
        expect(jump()).toBeNull();
        // And again by hand: up (it comes back), then down to the end (it goes).
        scrollTo(el, 300);
        expect(jump()).not.toBeNull();
        scrollTo(el, HEIGHT - BOX);
        expect(jump()).toBeNull();
    });

    it('it resumes following live: after the jump, a new message keeps the chat at its end', () => {
        const el = mount();
        scrollTo(el, 1200);
        act(() => jump()!.click());
        // Somewhere the layout did not put it: following would move it back to the end when the next message arrives.
        el.scrollTop = 0;
        act(() => root.render(<ChatFlyout thread={{ ...thread, messages: [...many, { id: 'm40', who: 'agent', from: 'atlas', text: 'newest', delivered: true, at: null }] }} onSend={() => {}} onClose={() => {}} widthStorage={null} />));
        expect(el.scrollTop).toBe(HEIGHT);
    });

    it('CONTROL for the above: scrolled up and NOT jumped, a new message leaves the reader where they are', () => {
        const el = mount();
        scrollTo(el, 1200);
        act(() => root.render(<ChatFlyout thread={{ ...thread, messages: [...many, { id: 'm40', who: 'agent', from: 'atlas', text: 'newest', delivered: true, at: null }] }} onSend={() => {}} onClose={() => {}} widthStorage={null} />));
        expect(el.scrollTop).toBe(1200);
        expect(jump()).not.toBeNull();
    });

    it('it never takes focus: a mouse press on it is cancelled, so the composer keeps the caret, and it is not a tab stop', () => {
        const el = mount();
        scrollTo(el, 1200);
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        jump()!.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
        expect(jump()!.tabIndex).toBe(-1);
    });

    it('it does not move the layout: it floats over the thread, outside the scroller, in an absolutely placed layer', () => {
        const el = mount();
        scrollTo(el, 1200);
        const b = jump()!;
        expect(el.contains(b)).toBe(false);
        const layer = b.closest('[data-chat-jump-layer]');
        expect(layer).not.toBeNull();
        expect(layer!.className.split(/\s+/)).toContain('absolute');
        // The layer lets the wheel and clicks through to the thread except on the button itself.
        expect(layer!.className.split(/\s+/)).toContain('pointer-events-none');
    });
});
