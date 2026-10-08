import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { declarationsFor, stripCssComments } from '../../lib/css-rules';

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

const BROKEN = `
.gwrap.lists-docked {
    padding-right: var(--lists-dock-w);
}
.lists-dock { top: var(--titlebar-h); }
`;

const FIXED = `
/* A comment naming .gwrap.lists-docked, which must not be mistaken for a rule. */
.gwrap.lists-docked .gbody {
    margin-right: var(--lists-dock-w);
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
        expect(declarationsFor(FIXED, '.gwrap.lists-docked .gbody')).toContain('margin-right');
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

    it('reserves the gutter on EVERY content row, not just the grid', () => {
        /**
         * REWRITTEN to the new contract, not loosened — and the rewrite is a BUG FIX.
         *
         * This asserted the reserve on `.gbody` alone, which was true and insufficient.
         * `Floor.tsx` returns `<>{deck}<div className="gbody">…</div></>`, so the deck
         * surface is a SIBLING of `.gbody` — and `.gbody` is `display: none` whenever a
         * surface is showing. So the ONE row being reserved was the hidden one, and pinning
         * the panel on the **Deck, which is the default surface**, put the dock straight over
         * the content. Same for the Agent view.
         *
         * The three roots are every branch of master.tsx's `deck` prop: `<Deck>`, `<AgentView>`,
         * and the `.agent-view-missing` sentence a stale route falls back to.
         *
         * The history is the argument for naming rows rather than trusting one: the rule once
         * read `.gbody, .gstatus`, and deleting the status bar took the whole rule with it.
         * Both failures are the same shape — a reserve that names rows one at a time is wrong
         * whenever the set of rows changes.
         *
         * Exact on the full prelude, deliberately: `declarationsFor` matches the normalised
         * selector list, so dropping a row fails here rather than passing on a partial match.
         */
        expect(
            declarationsFor(
                css,
                '.gwrap.lists-docked .gbody, .gwrap.lists-docked .deck, .gwrap.lists-docked .dashboard, .gwrap.lists-docked .agent-view, .gwrap.lists-docked .agent-view-missing',
            ),
        ).toContain('margin-right: var(--lists-dock-w)');
    });

    it('names every root the deck slot can render, so a new surface cannot be forgotten', () => {
        /**
         * EXHAUSTIVE BY DISCOVERY, not by recognition — and the first version of this test was
         * the latter, which is why this comment exists.
         *
         * As first shipped it walked three hard-coded `[tag, root]` pairs and `continue`d past
         * anything else. Adding the Workflow Dashboard to the slot therefore left the reserve
         * incomplete and this guard GREEN: the new root was never one of the three it knew to
         * ask about. Its own PR description had warned about exactly that shape ("a hard-coded
         * list would pass while an eleventh file reintroduced the broken form"), one surface
         * earlier.
         *
         * So it now reads the component tags OUT of the slot and fails on any it cannot
         * account for. A fourth surface cannot be added without this map changing, which is a
         * diff a human reads.
         */
        const page = readFileSync(join(__dirname, '../../pages/master.tsx'), 'utf8');
        const deckSlot = page.slice(page.indexOf('deck={'), page.indexOf('hideGrid={'));
        expect(deckSlot.length).toBeGreaterThan(100);

        /** Every component the slot can mount → the CSS root it renders. */
        const ROOTS: Record<string, string> = {
            AgentView: '.agent-view',
            Dashboard: '.dashboard',
            Deck: '.deck',
        };

        // Components, discovered. `<Icon`-style leaf elements inside a surface are not roots —
        // only the top-level branches of this prop are — so the scan is deliberately anchored
        // to the `) : (`-separated branch heads the slot is built from.
        const found = [...deckSlot.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1]!);
        const unknown = [...new Set(found)].filter((tag) => !(tag in ROOTS));
        expect(
            unknown,
            `the deck slot mounts ${unknown.join(', ')}, which this guard cannot account for — add each to ROOTS with the CSS root it renders, and put that root in the dock reserve`,
        ).toEqual([]);

        // Plus the inline fallback, which has no component of its own.
        const inlineRoots = deckSlot.includes('className="agent-view-missing"')
            ? ['.agent-view-missing']
            : [];

        const required = [...new Set([...found.map((tag) => ROOTS[tag]!), ...inlineRoots])];
        // The walk must have found something, or every assertion below is vacuous.
        expect(required.length).toBeGreaterThan(1);

        for (const root of required) {
            expect(
                css,
                `${root} is mounted in the deck slot, so it must be in the dock reserve or a pinned panel covers it`,
            ).toContain(`.gwrap.lists-docked ${root}`);
        }
    });

    it('does not put the reserve on .gright either — padding grows a flex item', () => {
        // Measured on the VMs: `padding-right` on `.gright` (flex: 1) kept the
        // header's WIDTH but grew the column's outer box, so the row overflowed
        // and squeezed `.gleft` from 300px to 163px. The rail shrank instead of
        // the Floor, and the whole header still moved.
        expect(declarationsFor(css, '.gwrap.lists-docked .gright')).toBeNull();
    });

    it('names neither header row, so neither can be moved by the rule', () => {
        expect(
            declarationsFor(css, '.gwrap.lists-docked .titlebar, .gwrap.lists-docked .gtoolbar'),
        ).toBeNull();
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
