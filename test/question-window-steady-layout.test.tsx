import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { QuestionApp, type QuestionAppView } from '../src/renderer/components/QuestionApp.js';

/**
 * THE QUESTION WINDOW NEVER SCROLLS SIDEWAYS, AND NOTHING IN IT JUMPS WHEN THE QUEUE GROWS (Tynn story #378).
 *
 * 1. A question with a wide code block and a wide table gave the window a horizontal scrollbar. Two causes: the question
 *    sits in a `<fieldset>`, whose `min-inline-size` is `min-content` by default, so the fieldset grew to the width of the
 *    widest unbreakable thing in it (a 300-character code line); and a Markdown `<table>` is not a scroll box, so a wide
 *    table widened everything around it. The content scroller is `overflow-y: auto`, which makes its x axis `auto` too,
 *    so the overflow became the window's scrollbar. The contract: the scroller never scrolls sideways; a code block and a
 *    table each scroll inside their own box (`overflow-x: auto`, at most the column's width); long unbroken text wraps
 *    (`overflow-wrap: anywhere`, the approval card's rule in the chat, genie#1503).
 * 2. The owner: "make FTQ use tabs for the request queue instead of buttons that stack and push the question ui down. We
 *    don't want UI that jumps around and rearranges just because a label or pending action or list is growing." The
 *    queue is one row of react-fancy Tabs of a fixed height, always present, never wrapping; what does not fit goes into
 *    a "+N" menu at its end. A question arriving adds a tab and moves nothing: the question body is the same element
 *    under the same strip, and the selected question stays selected.
 */

const WIDE_CODE = `const x = '${'a'.repeat(300)}';`;
const WIDE_TABLE = `| ${Array.from({ length: 14 }, (_, i) => `column_${i}_${'w'.repeat(20)}`).join(' | ')} |\n|${' --- |'.repeat(14)}\n| ${Array.from({ length: 14 }, (_, i) => `v${i}`).join(' | ')} |`;
const UNBROKEN = 'u'.repeat(400);
const wideQuestion = `Which one?\n\n\`\`\`ts\n${WIDE_CODE}\n\`\`\`\n\n${WIDE_TABLE}\n\nAnd ${UNBROKEN}.`;

const q = (n: number, question = `Question ${n}?`): DeckItem => ({
    id: `q${n}`, source: 'agent-question', agentId: `a${n}`, agentName: `agent${n}`, workspaceId: 'ws', workspaceName: 'Tynn.ai', workspaceColor: '#22aa88',
    title: `Title of question ${n} ${'long words '.repeat(6)}`, blocking: false, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Pick', question, options: [{ label: `You: did all three ${'x'.repeat(200)}` }, { label: 'B' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem);

const render = (view: QuestionAppView, picked: string | null = null) => renderToStaticMarkup(
    <QuestionApp view={view} picked={picked} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} onPick={() => {}} now={10_000} />,
);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use']);
interface El { readonly tag: string; readonly attrs: string; readonly start: number; end: number; readonly parent: El | null }
/**
 * Every element of static markup, with its parent: enough to ask "is A inside B" and "what is beside B" without a DOM.
 * One parse per markup: "inside" compares the elements themselves, so two parses of the same markup never meet.
 */
const parsed = new Map<string, El[]>();
function elements(markup: string): El[] {
    const known = parsed.get(markup);
    if (known) return known;
    const out: El[] = [];
    parsed.set(markup, out);
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
// Read as the browser reads the attribute: static markup escapes `&` in a class (`[&_pre]:…` is `[&amp;_pre]:…`).
const classes = (el: El): string[] => (/class="([^"]*)"/.exec(el.attrs)?.[1] ?? '').replace(/&amp;/g, '&').split(/\s+/).filter(Boolean);
const inside = (el: El, outer: El): boolean => { for (let p = el.parent; p; p = p.parent) if (p === outer) return true; return false; };
const attr = (el: El, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(el.attrs)?.[1];
const withAttr = (all: El[], name: string): El[] => all.filter((e) => new RegExp(`\\s${name}(=|\\s|$)`).test(e.attrs));
const one = (all: El[], name: string): El => {
    const found = withAttr(all, name);
    expect(found, `exactly one element with ${name}`).toHaveLength(1);
    return found[0] as El;
};
/** The window's own children, in order: what sits above the question body. */
const windowChildren = (all: El[]): El[] => { const w = one(all, 'data-question-window'); return all.filter((e) => e.parent === w); };

describe('the question window never scrolls sideways', () => {
    const html = render({ item: q(1, wideQuestion), waiting: 0, queue: [q(1, wideQuestion)] });
    const all = elements(html);
    const scroll = one(all, 'data-question-scroll');
    const text = one(all, 'data-question-text');
    const renderer = all.find((e) => inside(e, text) && e.attrs.includes('data-react-fancy-content-renderer')) as El;

    it('positive control: the question really drew a code block, a table and the unbroken word inside the scroller', () => {
        expect(renderer, 'the question text is a ContentRenderer').toBeDefined();
        const pre = all.filter((e) => e.tag === 'pre' && inside(e, renderer));
        const table = all.filter((e) => e.tag === 'table' && inside(e, renderer));
        expect(pre).toHaveLength(1);
        expect(table).toHaveLength(1);
        expect(html).toContain('a'.repeat(300));
        expect(html).toContain(UNBROKEN);
        expect(inside(text, scroll)).toBe(true);
    });

    it('the scroller scrolls up and down only: overflow-x hidden, and it may shrink below its content (min-w-0)', () => {
        expect(classes(scroll)).toEqual(expect.arrayContaining(['overflow-y-auto', 'overflow-x-hidden', 'min-w-0']));
    });

    it('nothing between the scroller and the question can grow to min-content: the form and every fieldset are min-w-0', () => {
        const form = one(all, 'data-deck-form');
        expect(classes(form)).toContain('min-w-0');
        const fieldsets = all.filter((e) => e.tag === 'fieldset' && inside(e, form));
        expect(fieldsets.length).toBeGreaterThan(0);
        for (const f of fieldsets) expect(classes(f), 'a fieldset is min-content wide by default').toContain('min-w-0');
    });

    it('a code block and a table scroll inside their own box, at most the column wide; long text wraps', () => {
        expect(classes(renderer)).toEqual(expect.arrayContaining([
            '[&_pre]:max-w-full', '[&_pre]:overflow-x-auto',
            '[&_table]:block', '[&_table]:max-w-full', '[&_table]:overflow-x-auto',
            '[overflow-wrap:anywhere]',
        ]));
    });

    it('the options are full-width cards in one column; a long title wraps between words, never widening the window (Tynn #646)', () => {
        const groups = all.filter((e) => attr(e, 'role') === 'group' && inside(e, scroll));
        expect(groups.length).toBeGreaterThan(0);
        for (const g of groups) expect(classes(g)).toEqual(expect.arrayContaining(['flex-col', 'w-full', 'min-w-0']));
        const options = withAttr(all, 'data-question-option');
        expect(options.length).toBe(2);
        // `[overflow-wrap:anywhere]` broke a title letter by letter in a narrow column ("approv / al"): gone.
        for (const o of options) {
            expect(classes(o)).toEqual(expect.arrayContaining(['w-full', 'min-w-0']));
            expect(classes(o)).not.toContain('[overflow-wrap:anywhere]');
        }
    });

    it('one rule, not two: the question form and the file drawer draw prose through the same containment', () => {
        for (const file of ['QuestionForm', 'QuestionApp']) {
            const src = readFileSync(`src/renderer/components/${file}.tsx`, 'utf8');
            const renderers = src.match(/<ContentRenderer\b[^>]*>/g) ?? [];
            expect(renderers.length, file).toBeGreaterThan(0);
            for (const r of renderers) expect(r, file).toMatch(/\bCONTAINED_PROSE\b/);
        }
    });
});

describe('the queue is one row of tabs that never moves the question', () => {
    const queue = [1, 2, 3, 4, 5, 6].map((n) => q(n));
    const single = render({ item: q(1), waiting: 0, queue: [q(1)] });
    const five = render({ item: q(1), waiting: 4, queue: queue.slice(0, 5) });
    const six = render({ item: q(1), waiting: 5, queue });

    const strip = (html: string) => one(elements(html), 'data-question-tabs');
    const tabs = (html: string) => elements(html).filter((e) => attr(e, 'role') === 'tab');
    const selected = (html: string) => tabs(html).filter((t) => attr(t, 'aria-selected') === 'true').map((t) => attr(t, 'data-question-queue-item'));

    it('a react-fancy tab strip of a fixed height that never wraps, with one tab per visible question', () => {
        for (const html of [single, six]) {
            const s = strip(html);
            const list = elements(html).find((e) => e === s || inside(e, s) ? e.attrs.includes('data-react-fancy-tabs-list') : false);
            expect(list, 'react-fancy Tabs.List').toBeDefined();
            expect(classes(s)).toEqual(expect.arrayContaining(['h-9', 'shrink-0', 'overflow-hidden']));
            expect(classes(list as El)).toEqual(expect.arrayContaining(['flex-nowrap']));
        }
        expect(tabs(single).map((t) => attr(t, 'data-question-queue-item'))).toEqual(['q1']);
    });

    it('the question body is the same element under the same strip with 1 or 6 questions: no list grows above it', () => {
        const shape = (html: string) => windowChildren(elements(html)).map((e) => `${e.tag}.${classes(e).join('.')}`);
        expect(shape(six)).toEqual(shape(single));
        // The old vertical list is gone.
        expect(six).not.toContain('data-question-queue=');
    });

    it('six questions: the tabs that fit, and the rest behind "+N" at the end of the strip (counted)', () => {
        const shown = tabs(six).map((t) => attr(t, 'data-question-queue-item'));
        const more = one(elements(six), 'data-question-tabs-more');
        const n = Number(attr(more, 'data-question-tabs-more'));
        expect(shown.length).toBeGreaterThan(0);
        expect(n).toBeGreaterThan(0);
        expect(shown.length + n).toBe(6);
        expect(six).toMatch(new RegExp(`data-question-tabs-more="${n}"[^>]*>(?:<[^>]*>)*\\+${n}<`));
        expect(inside(more, strip(six))).toBe(true);
        // Control: one question, nothing hidden.
        expect(withAttr(elements(single), 'data-question-tabs-more')).toHaveLength(0);
    });

    it('each tab: the agent, its colour dot and the title, truncated, with the whole of it in a tooltip', () => {
        const t = tabs(six).find((e) => attr(e, 'data-question-queue-item') === 'q2') as El;
        expect(t).toBeDefined();
        expect(attr(t, 'title')).toContain('agent2');
        expect(attr(t, 'title')).toContain(q(2).title.trim());
        const all = elements(six);
        const inTab = all.filter((e) => inside(e, t));
        expect(inTab.some((e) => classes(e).includes('truncate'))).toBe(true);
        expect(inTab.some((e) => e.attrs.includes('data-workspace-color="#22aa88"'))).toBe(true);
    });

    it('a question arriving never takes the selection: main’s question stays selected, and so does the person’s pick', () => {
        expect(selected(five)).toEqual(['q1']);
        expect(selected(six)).toEqual(['q1']);
        const picked5 = render({ item: q(1), waiting: 4, queue: queue.slice(0, 5) }, 'q3');
        const picked6 = render({ item: q(1), waiting: 5, queue }, 'q3');
        expect(selected(picked5)).toEqual(['q3']);
        expect(selected(picked6)).toEqual(['q3']);
    });

    it('the selected question always has its tab, even when it is past the ones that fit', () => {
        expect(selected(render({ item: q(1), waiting: 5, queue }, 'q6'))).toEqual(['q6']);
    });

    it('the header holds no count that grows: no "N more after this" beside a strip that shows them', () => {
        expect(six).not.toContain('more after this');
        expect(six).not.toContain('data-question-waiting=');
    });
});
