import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The FTQ file drawer scrolls — and it does so through the SAME chain the file
 * editor uses (genie#603).
 *
 * The owner's screenshot: a `.md` file in the drawer, no scrollbar, nothing past
 * the fold reachable. The stylesheet already SAID the right thing —
 *
 *     .ask-file-view { ...; overflow: hidden; }   / * the pane does not scroll * /
 *     .ask-file-view [data-fancy-code-panel] { flex: 1 1 auto; min-height: 0; }
 *
 * — and the comment above it named the editor as the model. What it missed is
 * that fancy-code nests the Panel inside a CodeEditor ROOT, and that root is a
 * plain `overflow-hidden` BLOCK. So `flex: 1 1 auto` on the Panel had no flex
 * parent to be a child of: the Panel sized to its content, grew past the pane,
 * and `.ask-file-view`'s `overflow: hidden` clipped the overflow away. One
 * missing link, and the scrollbar the rule was written to produce never existed.
 *
 * `overflow: auto` on `.ask-file-view` would have hidden that — a second
 * scroller wrapped around a pane designed to have exactly one, with the Panel's
 * own `overflow-auto` still nested inside it. The pane still CLIPS below, on
 * purpose, and that is asserted: it is what stops the bandaid coming back.
 *
 * `master.css` has carried the missing rule since the Code view shipped, which
 * is why the editor scrolls and the drawer did not. It is the positive control
 * here: if the editor ever stops declaring it, these assertions are pinning a
 * shape that no longer means anything and this file says so.
 */

const STYLES = path.resolve(__dirname, '../../styles');
const GLOBALS = fs.readFileSync(path.join(STYLES, 'globals.css'), 'utf8');
const MASTER = fs.readFileSync(path.join(STYLES, 'master.css'), 'utf8');

interface Rule {
    selectors: string[];
    body: string;
}

/** Every top-level rule in a stylesheet, comments stripped. */
function rules(css: string): Rule[] {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Rule[] = [];
    const re = /^([^@\s}][^{}]*)\{([^{}]*)\}/gm;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        out.push({ selectors: m[1]!.split(',').map((s) => s.trim()), body: m[2]! });
    }
    return out;
}

/** The body of the first rule whose selector list contains `selector`. */
function ruleBody(css: string, selector: string): string {
    const hit = rules(css).find((r) => r.selectors.includes(selector));
    if (!hit) throw new Error(`no rule for ${selector}`);
    return hit.body;
}

/** The value of `prop` in `selector`'s rule, or null when it declares none. */
function decl(css: string, selector: string, prop: string): string | null {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'm').exec(ruleBody(css, selector));
    return m ? m[1]!.trim().replace(/\s*!important$/, '') : null;
}

/** True when a declaration body asks for a scrollbar on either axis. */
function scrolls(body: string): boolean {
    return /(?:^|;)\s*overflow(?:-x|-y)?\s*:\s*(auto|scroll)/m.test(body);
}

/** The drawer's own chain: the pane, the editor root, the scrolling panel. */
const PANE = '.ask-file-view';
const EDITOR_ROOT = '.ask-file-view [data-fancy-code-editor]';
const PANEL = '.ask-file-view [data-fancy-code-panel]';

/** The editor's equivalents, which have been right the whole time. */
const EDITOR_ROOT_REF = '.code-host .code-editor-col > [data-fancy-code-editor]';
const PANEL_REF = '.code-host .code-editor-col [data-fancy-code-panel]';

describe('the drawer scrolls because every link in the chain is sized', () => {
    it('the CodeEditor ROOT is a full-height flex column — the link that was missing', () => {
        // fancy-code renders it as a bare `overflow-hidden` block. Left alone it
        // is neither a flex CONTAINER (so the Panel's `flex` is inert) nor a
        // shrinkable flex ITEM (so it cannot be squeezed to the pane's height).
        expect(decl(GLOBALS, EDITOR_ROOT, 'display')).toBe('flex');
        expect(decl(GLOBALS, EDITOR_ROOT, 'flex-direction')).toBe('column');
        expect(decl(GLOBALS, EDITOR_ROOT, 'min-height')).toBe('0');
        expect(decl(GLOBALS, EDITOR_ROOT, 'flex')).toMatch(/^1\b/);
    });

    it('the Panel fills that column and is not capped to its content', () => {
        expect(decl(GLOBALS, PANEL, 'flex')).toMatch(/^1\b/);
        expect(decl(GLOBALS, PANEL, 'min-height')).toBe('0');
        // fancy-code writes minHeight/maxHeight as INLINE styles from its props,
        // so only `!important` can defeat a cap the drawer never asked for.
        expect(ruleBody(GLOBALS, PANEL)).toMatch(/max-height:\s*none\s*!important/);
    });

    it('the pane itself still CLIPS — the Panel is the one scroller', () => {
        // The anti-bandaid pin. `overflow: auto` here produces a scrollbar
        // without fixing anything, wrapped around the Panel's own.
        expect(decl(GLOBALS, PANE, 'overflow')).toBe('hidden');
        expect(decl(GLOBALS, PANE, 'display')).toBe('flex');
        expect(decl(GLOBALS, PANE, 'flex-direction')).toBe('column');
        expect(decl(GLOBALS, PANE, 'min-height')).toBe('0');
    });

    it('POSITIVE CONTROL: the file editor sizes the same two elements the same way', () => {
        // If this goes red the drawer is being held to a shape the working
        // surface no longer has, and the assertions above mean nothing.
        expect(decl(MASTER, EDITOR_ROOT_REF, 'display')).toBe('flex');
        expect(decl(MASTER, EDITOR_ROOT_REF, 'flex-direction')).toBe('column');
        expect(decl(MASTER, EDITOR_ROOT_REF, 'min-height')).toBe('0');
        expect(decl(MASTER, PANEL_REF, 'min-height')).toBe('0');
        expect(ruleBody(MASTER, PANEL_REF)).toMatch(/max-height:\s*none\s*!important/);
    });
});

describe('the rendered-markdown pane owns its own scrollbar', () => {
    // There is no editor Panel under the rendered view to carry one, so this is
    // the one place in the drawer where the scroll region IS the container.
    const MD = '.ask-file-md';

    it('.ask-file-md scrolls', () => {
        expect(scrolls(ruleBody(GLOBALS, MD))).toBe(true);
    });

    it('.ask-file-md can be squeezed to the pane rather than pushing it open', () => {
        expect(decl(GLOBALS, MD, 'min-height')).toBe('0');
        expect(decl(GLOBALS, MD, 'flex')).toMatch(/^1\b/);
    });

    it('it is the ONLY new scroller — the code path still scrolls in the Panel', () => {
        const drawerScrollers = rules(GLOBALS)
            .filter((r) => r.selectors.some((s) => /\.ask-file-/.test(s)))
            .filter((r) => scrolls(r.body))
            .flatMap((r) => r.selectors);
        expect(drawerScrollers).toEqual([MD]);
    });
});

describe('no stylesheet left over from the FileViewer composition', () => {
    it('nothing styles [data-fancy-file-viewer] any more', () => {
        // The drawer renders <CodeEditor> directly now; a FileViewer wrapper is
        // never in the tree, so a rule for it is dead weight that reads as if
        // the old composition were still live.
        expect(GLOBALS).not.toContain('data-fancy-file-viewer');
    });

    it('POSITIVE CONTROL: it does style the elements that ARE in the tree', () => {
        // "X is absent" passes just as well against an empty stylesheet.
        expect(GLOBALS).toContain('data-fancy-code-editor');
        expect(GLOBALS).toContain('data-fancy-code-panel');
    });
});

describe('the drawer does not drift back to <FileViewer>', () => {
    const ASK = fs.readFileSync(path.resolve(__dirname, '../../pages/ask.tsx'), 'utf8');

    it('ask.tsx imports no FileViewer', () => {
        expect(ASK).not.toMatch(/\bFileViewer\b/);
    });

    it('POSITIVE CONTROL: it renders the drawer preview component instead', () => {
        expect(ASK).toMatch(/\bAskFilePreview\b/);
    });
});
