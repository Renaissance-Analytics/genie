import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { resetScrollOnQuestionChange } from '../src/core/question-scroll.js';
import { QuestionApp, type QuestionAppView } from '../src/renderer/components/QuestionApp.js';

/**
 * THE QUESTION WINDOW'S DRAG STRIP STAYS PUT, AND THE NEXT QUESTION SHOWS FROM ITS TOP (genie#1298, the owner on beta.49).
 *
 * 1. "The drag zone scrolls away with the list": the window could only be moved while the list was scrolled to the top.
 *    The drag strip must sit OUTSIDE the one container that scrolls, and that container must be the containing block of
 *    the absolutely positioned "Copied" live regions ContentRenderer puts in every question (react-fancy 5.67+) — the
 *    content scroller was not positioned, so they escaped it, the DOCUMENT grew taller than the window, and any
 *    programmatic scroll (a caret reveal, a focus) carried the whole page, header and all, upward (the genie#1290 cause,
 *    in this window). Genie 1 (v0.7.0-beta.342 renderer/pages/ask.tsx + renderer/styles/globals.css): `.ask-head`
 *    `-webkit-app-region: drag` (its buttons no-drag) above `.ask-body`, the one `overflow-y: auto` region, inside an
 *    `.ask-frame` of `height: 100vh; overflow: hidden`.
 * 2. "Answering doesn't scroll back to the top": the next queued question kept the scroll offset of the one answered.
 *    The content scroller goes back to the top whenever the question shown changes — by setting its scrollTop, never by
 *    a focus() (genie#1235) or a scrollIntoView, which would scroll the document (genie#1290).
 */

const long = (n: number) => `Question ${n}. ${'Prose that wraps. '.repeat(20)}\n\n\`\`\`ts\nconst x = ${n};\n\`\`\`\n`;
const q = (id: string): DeckItem => ({
    id, source: 'agent-question', agentId: `a_${id}`, agentName: 'kai', workspaceId: 'ws', workspaceName: 'Tynn.ai', title: `Pick ${id}`, blocking: false, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: 2, questions: [1, 2].map((n) => ({ header: `H${n}`, question: long(n), options: [{ label: 'A' }, { label: 'B' }] })) },
    forwardedFrom: null,
} as unknown as DeckItem);
const view: QuestionAppView = { item: q('q1'), waiting: 1, queue: [q('q1'), q('q2')] };
const html = renderToStaticMarkup(
    <QuestionApp view={view} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} now={10_000} onOpenFile={() => {}} onCloseFile={() => {}}
        drawer={{ path: 'notes.md', text: '# Notes\n\n```ts\nconst a = 1;\n```\n', line: null }} />,
);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use']);
interface El { readonly tag: string; readonly attrs: string; readonly start: number; end: number; readonly parent: El | null }
/** Every element of static markup, with the span it covers and its parent: enough to ask "is A inside B" without a DOM. */
function elements(markup: string): El[] {
    const out: El[] = [];
    const stack: El[] = [];
    for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
        const [, close, tag = '', attrs = '', self] = m;
        const at = m.index ?? 0;
        if (close) {
            const open = stack.pop();
            if (open) open.end = at + m[0].length;
            continue;
        }
        const el: El = { tag, attrs, start: at, end: at + m[0].length, parent: stack[stack.length - 1] ?? null };
        out.push(el);
        if (!self && !VOID.has(tag.toLowerCase())) stack.push(el);
    }
    return out;
}
const classes = (el: El): string[] => (/class="([^"]*)"/.exec(el.attrs)?.[1] ?? '').split(/\s+/);
const inside = (el: El, outer: El): boolean => { for (let p = el.parent; p; p = p.parent) if (p === outer) return true; return false; };
const all = elements(html);
const one = (attr: string): El => {
    const found = all.filter((e) => e.attrs.includes(attr));
    expect(found, `exactly one element with ${attr}`).toHaveLength(1);
    return found[0] as El;
};

describe('genie#1298: the drag strip never scrolls', () => {
    it('the markup parses into a tree (positive control: the form is inside the window)', () => {
        expect(all.length).toBeGreaterThan(40);
        expect(inside(one('data-deck-form='), one('data-question-window='))).toBe(true);
    });

    it('one fixed drag strip, -webkit-app-region: drag, outside the content scroller', () => {
        const drag = one('data-question-drag=');
        const scroll = one('data-question-scroll=');
        expect(drag.attrs).toMatch(/style="[^"]*-webkit-app-region:\s*drag/);
        expect(classes(drag)).toContain('shrink-0');
        expect(inside(drag, scroll)).toBe(false);
    });

    it('no scroller, and nothing inside one, carries an app region: scrolled content never maps a region over the strip', () => {
        // Chromium builds the window's drag map from every element with an app region, and a `no-drag` box that has
        // scrolled up under the strip punches a hole in it: the window moved only while the list was at the top. Outside
        // the drag strip there is nothing to exempt, so the scrollers say nothing at all.
        const scrollers = all.filter((e) => classes(e).some((c) => /^overflow-(y-)?(auto|scroll)$/.test(c)));
        expect(scrollers.length).toBeGreaterThanOrEqual(3);
        const regioned = all.filter((e) => /-webkit-app-region/.test(e.attrs));
        expect(regioned.length, 'positive control: the drag strip carries one').toBeGreaterThanOrEqual(1);
        for (const s of scrollers) {
            expect(s.attrs, 'a scroller with an app region').not.toMatch(/-webkit-app-region/);
            expect(regioned.filter((e) => inside(e, s)).map((e) => e.attrs)).toEqual([]);
        }
        // And nothing that scrolls is an ancestor of the strip, nor does the queue/question/drawer sit inside it.
        const drag = one('data-question-drag=');
        expect(all.filter((e) => inside(e, drag) && /data-question-(scroll|queue)=|data-deck-form=/.test(e.attrs))).toEqual([]);
    });

    it('the content scroller is the ONE that scrolls the question, and contains what is positioned in it', () => {
        const scroll = one('data-question-scroll=');
        expect(classes(scroll)).toEqual(expect.arrayContaining(['overflow-y-auto', 'min-h-0', 'flex-1', 'relative']));
        expect(inside(one('data-deck-form='), scroll)).toBe(true);
        // No other scroller between the window and the form.
        const form = one('data-deck-form=');
        for (let p = form.parent; p && p !== scroll; p = p.parent) expect(classes(p).some((c) => /^overflow-(y-)?(auto|scroll)$/.test(c)), `${p.tag} ${p.attrs}`).toBe(false);
    });

    it('every scroller in the window is the containing block of its absolutely positioned children (none escapes to grow the document)', () => {
        const scrollers = all.filter((e) => classes(e).some((c) => /^overflow-(y-)?(auto|scroll)$/.test(c)));
        // The queue, the question, the drawer's body: three.
        expect(scrollers.length).toBeGreaterThanOrEqual(3);
        for (const s of scrollers) expect(classes(s), s.attrs).toContain('relative');
    });

    it('the window itself is a fixed full-height column that never overflows', () => {
        const win = one('data-question-window=');
        expect(classes(win)).toEqual(expect.arrayContaining(['h-screen', 'overflow-hidden', 'flex-col']));
    });
});

describe('genie#1298: the next question shows from its top', () => {
    it('another question shown: the scroller goes back to the top', () => {
        const el = { scrollTop: 840 };
        expect(resetScrollOnQuestionChange(el, 'q1', 'q2')).toBe(true);
        expect(el.scrollTop).toBe(0);
    });

    it('the same question re-pushed (another agent asked meanwhile): the reader keeps their place', () => {
        const el = { scrollTop: 840 };
        expect(resetScrollOnQuestionChange(el, 'q1', 'q1')).toBe(false);
        expect(el.scrollTop).toBe(840);
    });

    it('never moves focus or scrolls anything else: only the scroller’s own scrollTop is set', () => {
        const touched: string[] = [];
        const el = new Proxy({ scrollTop: 300 } as Record<string, unknown>, {
            get: (t, k) => { if (k !== 'scrollTop') touched.push(String(k)); return t[k as string]; },
            set: (t, k, v) => { t[k as string] = v; if (k !== 'scrollTop') touched.push(`set ${String(k)}`); return true; },
        }) as unknown as { scrollTop: number };
        resetScrollOnQuestionChange(el, 'q1', 'q2');
        expect(touched).toEqual([]);
        expect(el.scrollTop).toBe(0);
    });

    it('no scroller mounted yet: nothing to do, nothing thrown', () => {
        expect(resetScrollOnQuestionChange(null, 'q1', 'q2')).toBe(false);
    });

    it('QuestionApp resets its content scroller in a layout effect keyed on the shown question id', () => {
        const src = readFileSync(new URL('../src/renderer/components/QuestionApp.tsx', import.meta.url), 'utf8');
        expect(src).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]{0,300}resetScrollOnQuestionChange\(scrollRef\.current,[\s\S]{0,200}\}, \[shownId\]\)/);
        expect(src).toMatch(/ref=\{scrollRef\}[^>]*data-question-scroll=""|data-question-scroll=""[^>]*ref=\{scrollRef\}/);
        expect(src).not.toMatch(/scrollIntoView/);
    });
});
