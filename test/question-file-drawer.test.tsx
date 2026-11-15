import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { QuestionApp, type QuestionAppView } from '../src/renderer/components/QuestionApp.js';

/**
 * THE QUESTION'S FILES, BESIDE IT — GENIE 1'S FILE DRAWER (the owner, 2026-10-19: "The Genie 1 FTQ ux was so much better
 * and included the context preview drawer"). A question that names `.ai/plans/spec.md` gets a chip for it; the chip opens
 * the file in a drawer beside the question (the window widens), Markdown as prose, anything else as code at the line the
 * question named. A named file that is not there is said, never offered as a chip.
 */

const item = {
    id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'atlas', workspaceId: 'tynn', title: 'Spec', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Spec', question: 'Does §3 of `.ai/plans/spec.md` still hold, given `src/core/route.ts:42`? See also `docs/gone.md`.', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem;
const view: QuestionAppView = { item, waiting: 0 };
const render = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} now={10_000} onOpenFile={() => {}} onCloseFile={() => {}} {...extra} />);

describe('the files a question names', () => {
    it('a chip per file that is there, in the order named, with its line or section; the missing one said, not offered', () => {
        const html = render({ existing: new Set(['.ai/plans/spec.md', 'src/core/route.ts']) });
        expect([...html.matchAll(/data-question-file="([^"]+)"/g)].map((m) => m[1])).toEqual(['.ai/plans/spec.md', 'src/core/route.ts']);
        expect(html).toMatch(/data-question-file="src\/core\/route.ts"[^>]*>[\s\S]*?:42/);
        expect(html).toMatch(/data-question-file-missing="docs\/gone.md"/);
        expect(html).not.toContain('data-question-file="docs/gone.md"');
    });

    it('existence unknown (the check failed): every named file is offered — fails OPEN, as Genie 1', () => {
        expect([...render({ existing: null }).matchAll(/data-question-file="([^"]+)"/g)]).toHaveLength(3);
    });
});

describe('the drawer', () => {
    it('open on a Markdown file: beside the question, named, the file as prose', () => {
        const html = render({ existing: null, drawer: { path: '.ai/plans/spec.md', text: '# Spec\n\n§3 **holds**.', line: null } });
        expect(html).toMatch(/data-question-drawer=".ai\/plans\/spec.md"/);
        expect(html).toMatch(/data-question-drawer[\s\S]*?spec\.md/);
        expect(html).toMatch(/<strong>holds<\/strong>/);
        expect(html).toContain('data-action="question-drawer-close"');
    });

    it('a refusal reads as the drawer’s sentence (outside the workspace, binary, missing)', () => {
        const html = render({ existing: null, drawer: { path: '../x.md', error: 'that file is not in this workspace' } });
        expect(html).toMatch(/data-question-drawer-error[^>]*>that file is not in this workspace</);
    });

    it('CONTROL: closed — no drawer at all', () => {
        expect(render({ existing: null })).not.toContain('data-question-drawer=');
    });
});

/*
 * Tynn #726: the drawer showed "not a text file" for a PNG. An image is drawn (scaled to fit, click to zoom), an SVG through
 * <img> and never as markup, a PDF and any other binary named with their size and an Open in Files action.
 */
describe('the drawer shows media (Tynn #726)', () => {
    const SRC = 'data:image/png;base64,iVBORw0KGgo=';
    const open = (path: string, media: unknown) => render({ existing: null, drawer: { path, media } });

    it('an image is an <img> scaled to fit, with a click-to-zoom control', () => {
        const html = open('shots/a.png', { kind: 'image', src: SRC, size: 2048 });
        expect(html).toMatch(/<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="/);
        // All three fit classes on the <img>, in any order.
        expect(html).toMatch(/<img(?=[^>]*class="[^"]*\bobject-contain\b)(?=[^>]*class="[^"]*\bmax-h-full\b)(?=[^>]*class="[^"]*\bmax-w-full\b)/);
        expect(html).toContain('data-action="question-drawer-zoom"');
        expect(html).not.toContain('not a text file');
    });

    it('an SVG goes through <img>, never inlined as markup', () => {
        const html = open('logo.svg', { kind: 'image', src: 'data:image/svg+xml;base64,PHN2Zy8+', size: 10 });
        expect(html).toMatch(/<img[^>]*src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
        expect(html).not.toMatch(/<svg/);
    });

    it('a PDF offers Open in Files with its name and size', () => {
        const html = open('docs/spec.pdf', { kind: 'pdf', size: 3 * 1024 * 1024 });
        expect(html).toMatch(/data-question-drawer-binary="pdf"/);
        expect(html).toContain('spec.pdf');
        expect(html).toContain('3.0 MB');
        expect(html).toContain('data-action="question-drawer-open-in-files"');
    });

    it('another binary shows its name, its size and Open in Files — not an error', () => {
        const html = open('data/blob.bin', { kind: 'binary', size: 1536 });
        expect(html).toMatch(/data-question-drawer-binary="binary"/);
        expect(html).toContain('blob.bin');
        expect(html).toContain('1.5 KB');
        expect(html).toContain('data-action="question-drawer-open-in-files"');
        expect(html).not.toContain('data-question-drawer-error');
    });

    it('CONTROL: a text file is still the viewer, with no media chrome', () => {
        const html = render({ existing: null, drawer: { path: 'a.ts', text: 'const a = 1;', line: null } });
        expect(html).not.toContain('question-drawer-zoom');
        expect(html).not.toContain('data-question-drawer-binary');
    });
});
