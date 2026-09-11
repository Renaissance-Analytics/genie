import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Pinning the lists panel must not move the header icons.
 *
 * The reserve used to sit on `.gwrap.lists-docked`, which is the whole app
 * shell — so pinning narrowed everything inside it, the titlebar and the
 * workspace toolbar included, and every header control slid left the moment the
 * panel was docked. The panel is supposed to pin UNDER the header, not reformat
 * it.
 *
 * ## Why this is a source test
 *
 * The renderer test env has no DOM — the sibling suite renders through
 * `react-dom/server` — so no test here can compute a layout. The regression is
 * purely in which selector carries the reserve, which IS readable from source.
 *
 * ## Why it is not vacuous
 *
 * A source guard that only ever runs against the fixed file passes for a
 * comparison that can never fail. So {@link declarationsFor} is a pure function
 * over CSS text, and the first two cases below feed it the BROKEN css and the
 * FIXED css as fixtures and assert it tells them apart. Only then do the rest
 * ask about the real stylesheet.
 *
 * Comments are stripped first, and with a real block strip rather than a
 * line-based one. The rules in question carry multi-line comments that name the
 * very selectors being asserted — `.gwrap.lists-docked` appears in the prose
 * explaining why it is no longer used — so an unstripped search finds the
 * comment and reports the opposite of the truth. A line-based strip would also
 * be inert here, because this file is checked out CRLF on Windows.
 */

/** Strip `/* … *\/` blocks, including multi-line ones, CRLF or LF. */
export function stripCssComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The declarations inside the first block whose selector list is exactly
 * `selector`, or null when no such rule exists. Exact match on the trimmed
 * prelude, so `.gwrap.lists-docked` does not accidentally answer for
 * `.gwrap.lists-docked .gright`.
 */
export function declarationsFor(css: string, selector: string): string | null {
    const body = stripCssComments(css);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(body)) !== null) {
        const prelude = m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).join(', ');
        if (prelude === selector) return m[2]!.trim();
    }
    return null;
}

const BROKEN = `
.gwrap.lists-docked {
    padding-right: var(--lists-dock-w);
}
.lists-dock { top: var(--titlebar-h); }
`;

const FIXED = `
/* A comment naming .gwrap.lists-docked, which must not be mistaken for a rule. */
.gwrap.lists-docked .gright {
    padding-right: var(--lists-dock-w);
}
.gwrap.lists-docked .titlebar,
.gwrap.lists-docked .gtoolbar {
    margin-right: calc(-1 * var(--lists-dock-w));
}
`;

const css = readFileSync(join(__dirname, '../../styles/master.css'), 'utf8');

describe('the guard can actually tell the two apart', () => {
    // Without these, every assertion below would pass against a matcher that
    // finds nothing in anything.
    it('finds the reserve on the shell in the BROKEN css', () => {
        expect(declarationsFor(BROKEN, '.gwrap.lists-docked')).toContain('padding-right');
    });

    it('does not find it there in the FIXED css, and is not fooled by the comment', () => {
        expect(declarationsFor(FIXED, '.gwrap.lists-docked')).toBeNull();
        expect(declarationsFor(FIXED, '.gwrap.lists-docked .gright')).toContain('padding-right');
    });

    it('strips a multi-line comment whole, not line by line', () => {
        expect(stripCssComments('a{/* one\ntwo\r\nthree */b:c}')).toBe('a{b:c}');
    });
});

describe('docking reserves the gutter without touching the header', () => {
    it('does not put the reserve on the whole shell', () => {
        // The regression, stated as the thing it is: a rule on `.gwrap` narrows
        // the header rows too.
        expect(declarationsFor(css, '.gwrap.lists-docked')).toBeNull();
    });

    it('reserves the gutter on the content column instead', () => {
        expect(declarationsFor(css, '.gwrap.lists-docked .gright')).toContain(
            'padding-right: var(--lists-dock-w)',
        );
    });

    it('pulls BOTH header rows back out of the reserve, so the icons do not move', () => {
        const decls = declarationsFor(
            css,
            '.gwrap.lists-docked .titlebar, .gwrap.lists-docked .gtoolbar',
        );
        expect(decls).toContain('margin-right: calc(-1 * var(--lists-dock-w))');
    });

    it('starts the dock below both header rows', () => {
        const decls = declarationsFor(css, '.lists-dock') ?? '';
        // Both tokens, because clearing only the titlebar is the half-fix that
        // leaves the dock overlapping the toolbar.
        expect(decls).toContain('--titlebar-h');
        expect(decls).toContain('--gtoolbar-h');
    });

    it('reads the toolbar height from one number, like the titlebar does', () => {
        // Two numbers for one row is a dock that overlaps the header by however
        // much they differ — the same reasoning `--lists-dock-w` already carries.
        expect(declarationsFor(css, '.gtoolbar')).toContain('height: var(--gtoolbar-h)');
        expect(css).toContain('--gtoolbar-h:');
    });
});
