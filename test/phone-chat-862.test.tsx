// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { MobileAgent } from '../src/renderer/components/MobileShell.js';

/**
 * THE PHONE'S AGENT CHAT (Tynn #862; the owner, 2026-11-18, on a phone over Tailscale): "the chat can't be scrolled on
 * mobile", and an agent's messages "didn't appear until I sent a message".
 *
 * SCROLL. The chat panel's scroller was a FLEX COLUMN (`flex flex-col`) holding one log (`min-h-full … justify-end`). A
 * flex item shrinks to its container: the log was squeezed to exactly the scroller's height (its `min-h-full` floor),
 * and `justify-end` pushed everything that did not fit out through its TOP — negative overflow, which no scroll can
 * reach. scrollHeight equalled clientHeight: nothing to scroll, by touch or by wheel, and the oldest messages were gone
 * above the screen. The desktop chat (ChatFlyout) has the same log in a BLOCK scroller, where `min-h-full` is a floor
 * the log grows past, downward, into the scroll. The phone's scroller is a block too now.
 *
 * Static markup cannot measure layout: this pins the structure, and the VM drive (scripts/mobile-proof/drive-scroll.mjs,
 * MOBILE_PROOF=scroll) measures a real touch scroll at phone viewports.
 *
 * LOADING. A chat whose history is still on its way (`rowsPending`, Tynn #659) said "Nothing yet." — a claim that the
 * agent has no conversation. It says it is loading. (Why the history did not ARRIVE until a send is the window's
 * forwarding: host-api.test.ts, "a phone that opens a chat gets its history".)
 */

const T = 1_760_000_000_000;
const message = (id: string, speaker: 'you' | 'agent', text: string, at: number) => ({ id, at, event: { kind: 'message', speaker, peerName: null, text } });
const detailWith = (rows: ReturnType<typeof message>[], over: Partial<AgentDetail> = {}): AgentDetail => ({
    agent: { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
    session: { running: true, turnState: 'idle', pendingApproval: null, failure: null, plan: null, startedAt: null } as unknown as AgentDetail['session'],
    rows: rows as unknown as AgentDetail['rows'],
    turns: 1, cost: null, refusal: null,
    ...over,
} as AgentDetail);
const history = Array.from({ length: 30 }, (_, i) => message(`m${i}`, i % 2 === 0 ? 'you' : 'agent', `message ${i}`, T + i * 1_000));

const noop = () => {};
const view = (detail: AgentDetail | null) => <MobileAgent detail={detail} sending={false} onBack={noop} onSend={noop} onStart={noop} onResumeLimit={noop} />;
const parse = (html: string): Document => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
const classes = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

describe('the phone chat scrolls (Tynn #862)', () => {
    it('the chat scroller is a BLOCK, as the desktop chat’s is: a flex column squeezes the log to its height and pushes the overflow out of reach above', () => {
        const doc = parse(renderToStaticMarkup(view(detailWith(history))));
        const scroller = doc.querySelector('[data-mobile-panel="chat"]');
        expect(scroller).not.toBeNull();
        // It is the screen's one bounded scroller (mobile-scroll.test.tsx's rule) …
        expect(classes(scroller)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain']));
        // … and NOT a flex container: its log is a block child that grows past it, downward, where scrolling reaches.
        expect(classes(scroller)).not.toContain('flex');
        expect(classes(scroller)).not.toContain('flex-col');
        const log = scroller!.querySelector(':scope > [data-chat-log]');
        expect(log).not.toBeNull();
        // The log fills a short chat (pinned to the bottom like the desktop's) and grows for a long one.
        expect(classes(log)).toEqual(expect.arrayContaining(['min-h-full', 'justify-end']));
        expect(doc.querySelectorAll('[data-chat-message]').length).toBe(30);
    });

    it('CONTROL: the desktop chat keeps the same log in a block scroller (what the phone now matches)', () => {
        const src = readFileSync(join(__dirname, '../src/renderer/components/ChatFlyout.tsx'), 'utf8');
        expect(src).toMatch(/data-chat-scroll=""[\s\S]{0,1200}className="relative min-h-0 flex-1 overflow-y-auto"/);
    });

    it('a chat still loading its history says so, never "Nothing yet." (which claims there is no conversation)', () => {
        const pending = parse(renderToStaticMarkup(view(detailWith([], { rowsPending: true } as Partial<AgentDetail>))));
        expect(pending.querySelector('[data-mobile-chat-loading]')).not.toBeNull();
        expect(pending.body.textContent).not.toMatch(/Nothing yet/);
        // CONTROL: a whole detail with no messages is the empty chat.
        const empty = parse(renderToStaticMarkup(view(detailWith([]))));
        expect(empty.querySelector('[data-mobile-chat-loading]')).toBeNull();
        expect(empty.body.textContent).toMatch(/Nothing yet/);
    });
});

/** The scroller's geometry, set by hand (happy-dom lays nothing out): what the follow logic reads. */
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => g.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => g.clientHeight });
}

describe('the phone chat follows the newest message only while the person is at the bottom (Tynn #862)', () => {
    const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        flags.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        flags.IS_REACT_ACT_ENVIRONMENT = false;
    });

    it('opens at the newest message; a new one keeps it there while at the bottom; scrolled up to read, a new one does not move it', () => {
        const g = { scrollHeight: 3_000, clientHeight: 600 };
        // Pending first, as the phone opens a chat whose history is on its way, then the history lands.
        act(() => root.render(view(detailWith([], { rowsPending: true } as Partial<AgentDetail>))));
        const scroller = host.querySelector<HTMLElement>('[data-mobile-panel="chat"]')!;
        geometry(scroller, g);
        act(() => root.render(view(detailWith(history))));
        expect(scroller.scrollTop).toBe(3_000);

        // At the bottom, a reply comes: it follows.
        g.scrollHeight = 3_200;
        act(() => root.render(view(detailWith([...history, message('m30', 'agent', 'a reply', T + 99_000)]))));
        expect(scroller.scrollTop).toBe(3_200);

        // The person scrolls up to read: the next reply leaves them where they are.
        scroller.scrollTop = 400;
        act(() => { scroller.dispatchEvent(new Event('scroll')); });
        g.scrollHeight = 3_400;
        act(() => root.render(view(detailWith([...history, message('m30', 'agent', 'a reply', T + 99_000), message('m31', 'agent', 'another', T + 100_000)]))));
        expect(scroller.scrollTop).toBe(400);

        // Back at the bottom: it follows again.
        scroller.scrollTop = 3_400 - 600;
        act(() => { scroller.dispatchEvent(new Event('scroll')); });
        g.scrollHeight = 3_600;
        act(() => root.render(view(detailWith([...history, message('m30', 'agent', 'a reply', T + 99_000), message('m31', 'agent', 'another', T + 100_000), message('m32', 'agent', 'more', T + 101_000)]))));
        expect(scroller.scrollTop).toBe(3_600);
    });
});
