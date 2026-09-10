import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeEditor } from '@particle-academy/fancy-code';
import AskFilePreview, { isMarkdownPath } from '../Ask/AskFilePreview';

/**
 * What the FTQ file drawer actually puts on screen (genie#603).
 *
 * The owner's report was three complaints about one pane: no scrollbars, no
 * word wrap, and a `.md` file shown as raw source with line numbers. The
 * scrollbar half is a stylesheet fact and is pinned in
 * `renderer/lib/__tests__/ask-file-drawer.test.ts`. The other two are facts
 * about the COMPOSITION, and they are asserted here against the real DOM the
 * component produces — not against the props it was handed.
 *
 * ## What the word-wrap assertions are, and are not
 *
 * They are a REGRESSION PIN, not the test that caught the bug — and saying so
 * is the point, because a green assertion about a symptom nobody fixed is how
 * a suite starts lying.
 *
 * The bug report said "no word wrap". It was measured before anything was
 * changed: the OLD `<FileViewer filename value wordWrap />` composition already
 * rendered its highlight layer with `white-space: pre-wrap`. The prop was
 * reaching the DOM the whole time. What the owner saw was the FIRST bug — a
 * pane that clipped instead of scrolling — and a clipped view of a file reads
 * as an unwrapped one. There was no second defect to fix.
 *
 * So these assertions guard the rewrite, not the report: the composition was
 * replaced wholesale, and dropping `wordWrap` on the way through would be an
 * easy and invisible mistake. They read `white-space` on the highlight layer
 * because that is what actually decides whether a line wraps, and an unwrapped
 * editor is rendered beside them so the assertion can be seen to fail.
 *
 * The renderer has no jsdom harness (see vitest.config.ts), so this renders
 * through `react-dom/server`. Everything asserted is static markup — layout,
 * scroll position and the wrap TOGGLE are not observable here, which is why the
 * stylesheet test exists beside it.
 */

const MARKDOWN = ['# Ship it', '', 'A paragraph with a very long line.', ''].join('\n');

const render = (filename: string, content: string, source = false): string =>
    renderToStaticMarkup(
        React.createElement(AskFilePreview, { filename, content, source }),
    );

describe('which files render as prose', () => {
    it('claims exactly what the editor\'s Document plugin claims, minus .docx', () => {
        // `main/plugins/official.ts` — the Document plugin claims
        // .md/.markdown/.mdc/.docx. `.docx` is binary and `files:read` refuses
        // binary, so it can never reach this drawer.
        expect(isMarkdownPath('.ai/plans/thing.md')).toBe(true);
        expect(isMarkdownPath('README.markdown')).toBe(true);
        expect(isMarkdownPath('.cursor/rules/x.mdc')).toBe(true);
    });

    it('leaves code alone', () => {
        expect(isMarkdownPath('main/db.ts')).toBe(false);
        expect(isMarkdownPath('renderer/pages/ask.tsx')).toBe(false);
        expect(isMarkdownPath('composer.json')).toBe(false);
        // Not a markdown file — a file whose NAME merely ends in those letters.
        expect(isMarkdownPath('notes/readme.mdx')).toBe(false);
        expect(isMarkdownPath('somemd')).toBe(false);
    });

    it('is case-insensitive, the way a filesystem is', () => {
        expect(isMarkdownPath('README.MD')).toBe(true);
    });
});

describe('a markdown file renders as markdown, not as source', () => {
    const html = render('plan.md', MARKDOWN);

    it('the heading is a heading', () => {
        expect(html).toMatch(/<h1[^>]*>Ship it<\/h1>/);
    });

    it('it goes through Fancy\'s renderer rather than a hand-rolled one', () => {
        // react-fancy's <ContentRenderer format="markdown"> — a full CommonMark
        // + GFM parse, sanitised. Nothing markdown-shaped is written in Genie.
        expect(html).toContain('data-react-fancy-content-renderer');
    });

    it('there is no code buffer and no line numbers behind it', () => {
        expect(html).not.toContain('data-fancy-code-panel');
        expect(html).not.toContain('<textarea');
    });

    it('it sits in the pane that scrolls', () => {
        expect(html).toContain('ask-file-md');
    });
});

describe('the same file, asked for as source', () => {
    const html = render('plan.md', MARKDOWN, true);

    it('is a code buffer again', () => {
        expect(html).toContain('data-fancy-code-panel');
    });

    it('shows the markdown as written, not as prose', () => {
        expect(html).not.toMatch(/<h1[^>]*>Ship it<\/h1>/);
        expect(html).toContain('# Ship it');
    });
});

describe('a code file', () => {
    const html = render('main/db.ts', 'const a = 1;\n');

    it('renders in the editor Panel — the composition the file editor uses', () => {
        expect(html).toContain('data-fancy-code-editor');
        expect(html).toContain('data-fancy-code-panel');
    });

    it('is read-only', () => {
        expect(html).toMatch(/<textarea[^>]*readonly/i);
    });

    it('ignores the source toggle, which only has meaning for prose', () => {
        expect(render('main/db.ts', 'const a = 1;\n', true)).toContain('data-fancy-code-panel');
    });
});

describe('long lines wrap (regression pin — see the note above)', () => {
    /** The `white-space` the highlight layer is rendered with. */
    function whiteSpace(html: string): string | null {
        const m = /white-space:\s*([a-z-]+)/.exec(html);
        return m ? m[1]! : null;
    }

    it('the drawer wraps', () => {
        expect(whiteSpace(render('main/db.ts', 'const a = 1;\n'))).toBe('pre-wrap');
    });

    it('and wraps in the markdown SOURCE view too', () => {
        expect(whiteSpace(render('plan.md', MARKDOWN, true))).toBe('pre-wrap');
    });

    it('POSITIVE CONTROL: an unwrapped editor reads differently', () => {
        // Without this, `pre-wrap` could be fancy-code's default and the two
        // assertions above would pass against a drawer that never asked to wrap.
        const unwrapped = renderToStaticMarkup(
            React.createElement(CodeEditor, {
                value: 'const a = 1;\n',
                language: 'typescript',
                wordWrap: false,
                children: React.createElement(CodeEditor.Panel, {}),
            }),
        );
        expect(whiteSpace(unwrapped)).toBe('pre');
    });
});

/**
 * The drawer's editor is DARK, because every editor in Genie is (genie#603
 * follow-up).
 *
 * `<FileViewer>` defaulted to `theme="auto"` and the rewrite carried that value
 * over unexamined — deliberately, as a colour nobody could look at, but wrongly.
 * The file editor does not guess: `CodePanel.tsx` PINS `theme="dark"`, and that
 * is a repo-wide convention rather than one component's taste. `--term-bg` /
 * `--term-fg` are declared once with dark values and never flip, and
 * `.tpanel-head`'s light ink on a permanently dark ground is correct for the
 * same reason. Terminals and editors stay dark in both themes here.
 *
 * `auto` is not "the app's theme" either, which is what made the divergence
 * invisible: fancy-code resolves it from the OS `prefers-color-scheme`, while
 * Genie's theme is a `.dark` class that `_app.tsx` owns and a pinned preference
 * can set AGAINST the OS. So the drawer could disagree with the window it sits
 * in and with every other editor in the app at the same time.
 *
 * Two assertions, because they fail for different reasons. The first is about
 * this component and reads the colour actually rendered; the second is about the
 * two surfaces staying in step, and is the property that stops them drifting
 * apart the way the scroll chain already had.
 */
describe('the drawer editor matches the file editor, and both are dark', () => {
    /** The background colour fancy-code paints the Panel with. */
    function panelBackground(html: string): string | null {
        const m = /background-color:\s*([^;"]+)/.exec(html);
        return m ? m[1]!.trim() : null;
    }

    /** A bare CodeEditor at `theme`, as the reference for what that theme looks like. */
    function referenceAt(theme: string): string {
        return renderToStaticMarkup(
            React.createElement(CodeEditor, {
                value: 'const a = 1;\n',
                language: 'typescript',
                theme,
                children: React.createElement(CodeEditor.Panel, {}),
            }),
        );
    }

    it('renders on the dark ground, not the light one', () => {
        const drawer = panelBackground(render('main/db.ts', 'const a = 1;\n'));
        expect(drawer).toBe(panelBackground(referenceAt('dark')));
    });

    it('POSITIVE CONTROL: the light theme is a different colour', () => {
        // Without this, "it matches dark" would pass against a build where every
        // theme resolved to the same grey — and `theme="auto"` renders LIGHT in
        // this environment (fancy-code's server snapshot is `prefers-dark:
        // false`), which is exactly the value being ruled out.
        expect(panelBackground(referenceAt('light'))).not.toBe(
            panelBackground(referenceAt('dark')),
        );
        expect(panelBackground(referenceAt('auto'))).toBe(panelBackground(referenceAt('light')));
    });

    it('passes the SAME theme the file editor pins, so the two cannot drift', () => {
        // Source-level, because the editor cannot be rendered here — CodePanel is
        // a whole panel with an IPC bridge behind it. What can be compared is the
        // decision each surface makes, which is the thing that drifted.
        const themeOf = (file: string): string => {
            const src = fs
                .readFileSync(path.resolve(__dirname, '..', file), 'utf8')
                // Prose about a theme must not be mistaken for passing one.
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
            const hits = [...src.matchAll(/\btheme="([a-z]+)"/g)].map((m) => m[1]!);
            expect(hits, `expected exactly one theme= in ${file}`).toHaveLength(1);
            return hits[0]!;
        };
        expect(themeOf('Ask/AskFilePreview.tsx')).toBe(themeOf('Code/CodePanel.tsx'));
        // Named too: matching each other on "auto" would satisfy the line above
        // while both diverged from every other editor surface in Genie.
        expect(themeOf('Ask/AskFilePreview.tsx')).toBe('dark');
    });
});
