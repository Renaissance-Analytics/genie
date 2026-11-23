// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fullPlanView } from '../src/core/chat-plan.js';
import { PlanHover, PlanHoverList, planListMaxHeight, revealCurrentStep } from '../src/renderer/components/PlanHover.js';

/**
 * THE DASHBOARD'S PLAN POPOVER SCROLLS (Tynn #1021). A long plan ("27/77") grew the popover past the bottom of the screen,
 * with no scroll. Now: its height is capped to the room the viewport has beside the trigger, the "n/m" header stays put,
 * the steps scroll inside it, and on open the step in progress is scrolled into view.
 */
const LONG = Array.from({ length: 77 }, (_, i) => ({
    content: `Step ${i + 1} of the long plan`,
    status: i < 27 ? 'completed' : i === 27 ? 'in_progress' : 'pending',
}));
const plan = fullPlanView(LONG)!;

describe('planListMaxHeight: the room beside the trigger, less the popover chrome', () => {
    it('a trigger near the top: the room below it', () => {
        // 900 - 120 below, less the 8 px offset, an 8 px margin and the content's 26 px of padding and border.
        expect(planListMaxHeight({ top: 100, bottom: 120 }, 900)).toBe(738);
    });

    it('a trigger near the bottom: the room above it (the popover flips up)', () => {
        // 800 above, less the offset, the margin and the chrome: 800 - 8 - 8 - 26.
        expect(planListMaxHeight({ top: 800, bottom: 820 }, 900)).toBe(758);
    });

    it('is never taller than the viewport, and keeps a usable floor in a tiny window', () => {
        expect(planListMaxHeight({ top: 0, bottom: 0 }, 900)).toBeLessThanOrEqual(900 - 16 - 26);
        expect(planListMaxHeight({ top: 90, bottom: 110 }, 200)).toBe(96);
    });
});

describe('revealCurrentStep: the step in progress, centred in the scrolling list', () => {
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height });
    it('scrolls so the current item sits in the middle of the list, within the scrollable range', () => {
        const item = { getBoundingClientRect: () => rect(690, 20) };
        const box = { scrollTop: 0, clientHeight: 300, scrollHeight: 1540, getBoundingClientRect: () => rect(150, 300), querySelector: () => item };
        expect(revealCurrentStep(box)).toBe(400);
        expect(box.scrollTop).toBe(400);
    });

    it('clamps at the ends, and leaves the list alone with no current step (control)', () => {
        const near = { scrollTop: 0, clientHeight: 300, scrollHeight: 1540, getBoundingClientRect: () => rect(150, 300), querySelector: () => ({ getBoundingClientRect: () => rect(170, 20) }) };
        expect(revealCurrentStep(near)).toBe(0);
        const last = { scrollTop: 0, clientHeight: 300, scrollHeight: 1540, getBoundingClientRect: () => rect(150, 300), querySelector: () => ({ getBoundingClientRect: () => rect(1670, 20) }) };
        expect(revealCurrentStep(last)).toBe(1240);
        const none = { scrollTop: 37, clientHeight: 300, scrollHeight: 1540, getBoundingClientRect: () => rect(150, 300), querySelector: () => null };
        expect(revealCurrentStep(none)).toBe(37);
        expect(none.scrollTop).toBe(37);
    });
});

describe('the list: a fixed header over a scrolling list of steps', () => {
    it('caps its height, keeps the n/m header outside the scroll area, and the steps inside it', () => {
        const html = renderToStaticMarkup(<PlanHoverList plan={plan} maxHeight={400} />);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const root = doc.querySelector('[data-plan-full]') as HTMLElement;
        expect(root.style.maxHeight).toBe('400px');
        expect(root.className).toMatch(/\bflex-col\b/);
        const head = root.querySelector('[data-plan-head]')!;
        const scroll = root.querySelector('[data-plan-scroll]')!;
        expect(head.textContent).toBe('27/77');
        expect(scroll.contains(head)).toBe(false);
        expect(scroll.className).toMatch(/\boverflow-y-auto\b/);
        expect(scroll.className).toMatch(/\bmin-h-0\b/);
        expect(head.className).toMatch(/\bshrink-0\b/);
        expect(scroll.querySelectorAll('li').length).toBe(77);
    });
});

describe('the Dashboard popover, opened by hover', () => {
    let host: HTMLDivElement;
    let root: Root;
    const saved = { innerHeight: window.innerHeight };
    beforeEach(() => {
        vi.useFakeTimers();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
        // happy-dom has no layout: the trigger sits at 100-120, the list box at 150 and 300 tall, each step 20 tall.
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            const r = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
            if (this.hasAttribute('data-plan-scroll')) return r(150, 300);
            const li = this.closest('[data-plan-scroll] li');
            if (li) return r(150 + [...li.parentElement!.children].indexOf(li) * 20, 20);
            if (this.matches('[data-plan-hover]') || this.querySelector('[data-plan-hover]')) return r(100, 20);
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

    it('caps the list to the room below the trigger and scrolls the step in progress into view', () => {
        act(() => root.render(<PlanHover plan={plan}><span>27/77 · Step 28 of the long plan</span></PlanHover>));
        const trigger = host.querySelector('[data-plan-hover]')!;
        act(() => { trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
        act(() => { vi.advanceTimersByTime(250); });
        const list = document.querySelector('[data-plan-full]') as HTMLElement | null;
        expect(list).not.toBeNull();
        expect(list!.style.maxHeight).toBe('738px');
        const scroll = list!.querySelector('[data-plan-scroll]') as HTMLElement;
        expect(scroll.querySelector('[data-current="true"]')?.textContent).toContain('Step 28 of the long plan');
        // Step 28 is at 150 + 27 * 20 = 690; centred in a 300 px list: 540 - (300 - 20) / 2 = 400.
        expect(scroll.scrollTop).toBe(400);
    });
});
