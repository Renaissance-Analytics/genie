// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatPlanView, fullPlanView } from '../src/core/chat-plan.js';
import { ChatPlanLine, ChatPlanList } from '../src/renderer/components/ChatPlanLine.js';
import { PlanHoverList } from '../src/renderer/components/PlanHover.js';

/**
 * THE CHAT HEADER'S PLAN POPOVER SCROLLS TOO (Tynn #1021; the owner: "plan popovers"). "Working · Plan n/m" opens the open
 * items of the plan; a long plan ran it off the screen as it did the Dashboard's. The same frame now holds both: the list
 * capped to the room beside the trigger, the steps scrolling inside it, what is not a step (the chat's "n done") fixed
 * outside the scroll, and the step in progress scrolled into view on open.
 */
const doneThenOpen = Array.from({ length: 77 }, (_, i) => ({ content: `Step ${i + 1} of the long plan`, status: i < 10 ? 'completed' : i === 10 ? 'in_progress' : 'pending' }));
// Open items with the step in progress 28th among them (a provider may leave earlier items pending).
const deepCurrent = Array.from({ length: 77 }, (_, i) => ({ content: `Step ${i + 1} of the long plan`, status: i === 27 ? 'in_progress' : 'pending' }));

describe('the chat list: the open steps scroll, the done count stays put', () => {
    it('caps its height, scrolls its steps, and keeps "n done" outside the scroll area', () => {
        const html = renderToStaticMarkup(<ChatPlanList plan={chatPlanView(doneThenOpen)!} maxHeight={400} />);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const root = doc.querySelector('[data-plan-popover]') as HTMLElement;
        expect(root.style.maxHeight).toBe('400px');
        const scroll = root.querySelector('[data-plan-scroll]');
        expect(scroll).not.toBeNull();
        expect(scroll!.className).toMatch(/\boverflow-y-auto\b/);
        expect(scroll!.querySelectorAll('li').length).toBe(67);
        const done = root.querySelector('[data-plan-done]')!;
        expect(done.textContent).toContain('10 done');
        expect(scroll!.contains(done)).toBe(false);
        expect(done.className).toMatch(/\bshrink-0\b/);
    });

    it('is the same frame as the Dashboard popover (one shared component, not a copy)', () => {
        const chat = new DOMParser().parseFromString(renderToStaticMarkup(<ChatPlanList plan={chatPlanView(doneThenOpen)!} maxHeight={400} />), 'text/html');
        const dash = new DOMParser().parseFromString(renderToStaticMarkup(<PlanHoverList plan={fullPlanView(doneThenOpen)!} maxHeight={400} />), 'text/html');
        const frame = (d: Document) => d.querySelector('[data-plan-frame]') as HTMLElement | null;
        expect(frame(chat)).not.toBeNull();
        expect(frame(dash)).not.toBeNull();
        expect(frame(chat)!.className).toBe(frame(dash)!.className);
        expect(frame(chat)!.querySelector('[data-plan-scroll]')!.className).toBe(frame(dash)!.querySelector('[data-plan-scroll]')!.className);
    });
});

describe('the chat header popover, opened by hover', () => {
    let host: HTMLDivElement;
    let root: Root;
    const saved = { innerHeight: window.innerHeight };
    beforeEach(() => {
        vi.useFakeTimers();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
        // happy-dom has no layout: the line sits at 100-120, the list box at 150 and 300 tall, each step 20 tall.
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            const r = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
            if (this.hasAttribute('data-plan-scroll')) return r(150, 300);
            const li = this.closest('[data-plan-scroll] li');
            if (li) return r(150 + [...li.parentElement!.children].indexOf(li) * 20, 20);
            if (this.matches('[data-plan-line]') || this.querySelector('[data-plan-line]')) return r(100, 20);
            return r(0, 0);
        });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-plan-scroll') ? 300 : 0; } });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-plan-scroll') ? 77 * 20 : 0; } });
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: saved.innerHeight });
    });

    it('caps the list to the room below the line and scrolls the step in progress into view', () => {
        act(() => root.render(<ChatPlanLine text="Working · Plan 0/77 · Step 28 of the long plan" plan={chatPlanView(deepCurrent)!} />));
        const line = host.querySelector('[data-plan-line]')!;
        act(() => { line.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
        act(() => { vi.advanceTimersByTime(250); });
        const list = document.querySelector('[data-plan-popover]') as HTMLElement | null;
        expect(list).not.toBeNull();
        // The same room as the Dashboard's: 900 - 120 below, less the offset, the margin and the chrome.
        expect(list!.style.maxHeight).toBe('738px');
        const scroll = list!.querySelector('[data-plan-scroll]') as HTMLElement | null;
        expect(scroll).not.toBeNull();
        expect(scroll!.querySelector('[data-current="true"]')?.textContent).toContain('Step 28 of the long plan');
        // Step 28 is at 150 + 27 * 20 = 690; centred in a 300 px list: 540 - (300 - 20) / 2 = 400.
        expect(scroll!.scrollTop).toBe(400);
    });
});
