// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread, type ChatThreadMessage } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE CHAT NEVER SCROLLS SIDEWAYS (the owner, 2026-11-04, Tynn task #944, with a screenshot of the notice row
 * `genie → tynn · told tynn about 1 AgentInbox message` and under it "from tynn-slaveDiagnostic76ec PRnative126992199702
 * passes row10 …" running off the column).
 *
 * THE CAUSE: each entry of that notice is a react-fancy `Button`, and the Button puts its children in ONE inline label
 * span (`data-react-fancy-button-label`, no display of its own). Inside it the subject was a `truncate` span — but
 * `truncate` (overflow hidden + nowrap + ellipsis) only clips a BLOCK or a flex item; on an inline span the nowrap holds
 * and the clip does not, so the subject drew as one unbreakable line through the button, the row and the log. The
 * scroller scrolls on y, so CSS computes its x overflow to `auto` as well, and the over-wide line became a horizontal
 * scrollbar for the whole chat. The `gap-2` meant for the two spans had no flex container either, which is why the
 * screenshot reads "tynn-slaveDiagnostic" with no space.
 *
 * THE RULES PINNED: (1) the column breaks long tokens itself — `overflow-wrap: anywhere` on the log is inherited by every
 * row, so a long unbroken word or URL wraps inside the column's width (and, unlike `break-word`, it lowers the rows'
 * min-content width, so flex rows can shrink); code blocks keep scrolling inside their own box (react-fancy's
 * `[&_pre]:overflow-x-auto`). (2) Every one-line clip in a chat row (`truncate`, `whitespace-nowrap`) sits where it can
 * clip: on a flex item, or on a block. Not an `overflow-x: hidden` on the column, which would cut text off unseen.
 *
 * Structure, not pixels (happy-dom has no layout, docs/decisions.md D3). Not proven here: the measured width in a real
 * window.
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

const LONG = 'Diagnostic76ecPRnative126992199702passesrow10'.repeat(4);
const at = 1_762_000_000_000;
/** One of every row the chat draws, each carrying a long unbroken token. */
const ROWS: ChatThreadMessage[] = [
    { id: 'you', who: 'you', from: 'you', text: `look at ${LONG}`, delivered: true, at, waiting: { step: LONG, since: at, kind: null } },
    { id: 'agent', who: 'agent', from: 'tynn', text: `Here: \`${LONG}\` and ${LONG}\n\n\`\`\`\n${LONG} ${LONG}\n\`\`\``, delivered: true, at },
    { id: 'mail', who: 'mail', from: 'tynn-slave → tynn', text: LONG, delivered: true, at, mailId: 'mail_1' },
    { id: 'mail-waiting', who: 'mail', from: 'tynn-slave → tynn', text: LONG, delivered: false, at, mailId: 'mail_2', reason: LONG },
    { id: 'delivery', who: 'delivery', from: 'genie → tynn', text: 'told tynn about 1 AgentInbox message', delivered: true, at, mail: [{ id: 'mail_1', from: 'tynn-slave', subject: LONG }] },
    { id: 'system', who: 'system', from: 'tynn', text: `tynn → wren · ${LONG}`, delivered: true, at },
    { id: 'stopped', who: 'stopped', from: 'tynn', text: `Stopped · ${LONG}`, delivered: true, at },
    { id: 'thinking', who: 'thinking', from: 'tynn', text: LONG, delivered: true, at },
];
const thread: ChatThread = { agentId: 'agent_t', name: 'tynn', fidelity: 'declared', unread: null, messages: ROWS, context: { tone: 'bad', text: `Broken · ${LONG}` } };

const mount = (onOpenMail?: (id: string) => void) => {
    act(() => root.render(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} widthStorage={null} onOpenMail={onOpenMail} />));
    return host.querySelector<HTMLElement>('[data-chat-log]')!;
};
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const isFlex = (el: Element | null) => el !== null && classes(el).some((c) => c === 'flex' || c === 'inline-flex' || c === 'grid');
const BLOCKS = new Set(['DIV', 'P', 'LI', 'SECTION', 'PRE', 'SUMMARY', 'DETAILS']);

describe('the chat never scrolls sideways', () => {
    it('the column breaks long tokens itself: overflow-wrap anywhere on the log, and the log may shrink (min-w-0)', () => {
        const log = mount();
        expect(classes(log)).toEqual(expect.arrayContaining(['[overflow-wrap:anywhere]', 'min-w-0']));
        // Not by hiding the overflow: the scroller and the log never clip x.
        const scroller = host.querySelector('[data-chat-scroll]')!;
        for (const el of [scroller, log]) expect(classes(el).filter((c) => /^overflow(-x)?-(hidden|clip)$/.test(c))).toEqual([]);
    });

    it('CONTROL: every row kind rendered, each with its long token (so the next rule counts real rows)', () => {
        const log = mount(() => {});
        const kinds = [...log.querySelectorAll('[data-chat-message]')].map((e) => e.getAttribute('data-who'));
        expect(kinds).toEqual(['you', 'agent', 'mail', 'mail', 'system', 'stopped', 'thinking']);
        expect(log.querySelector('[data-chat-message="mail"]')!.textContent).toContain(LONG);
        expect(log.querySelector('[data-who="delivery"]')).toBeNull();
        expect(log.querySelector('[data-chat-error]')!.textContent).toContain(LONG);
    });

    for (const openable of [true, false]) {
        it(`every one-line clip in a row is a block or a flex item, so it clips (the notice's entries ${openable ? 'as buttons' : 'as text'})`, () => {
            const log = mount(openable ? () => {} : undefined);
            // Genie's own row markup: a reply's rendered Markdown is react-fancy's (its code blocks scroll in their own box).
            const clips = [...log.querySelectorAll('*')].filter((el) => !el.closest('[data-chat-prose]') && classes(el).some((c) => c === 'truncate' || c === 'whitespace-nowrap'));
            // Positive control: the queued step IS a clipped label, so an empty list cannot pass for a clean one.
            expect(clips.some((el) => el.textContent === LONG)).toBe(true);
            const stuck = clips.filter((el) => !BLOCKS.has(el.tagName) && !isFlex(el.parentElement)).map((el) => `${el.tagName.toLowerCase()} in ${el.parentElement?.tagName.toLowerCase()}.${classes(el.parentElement!).join('.')}`);
            expect(stuck).toEqual([]);
        });
    }

    it('the waiting card retains its sender and long refusal text without resurrecting the delivery nudge', () => {
        const log = mount(() => {});
        const entry = log.querySelector('[data-chat-message="mail-waiting"]')!;
        expect(entry.textContent).toContain('tynn-slave → tynn');
        const refusal = entry.querySelector('[data-mail-refusal]');
        expect(refusal).not.toBeNull();
        expect(refusal!.textContent).toBe(LONG);
        expect(log.querySelector('[data-who="delivery"]')).toBeNull();
    });
});
