import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * THE STYLESHEETS ACTUALLY PARSE.
 *
 * ## The failure this exists for, which happened
 *
 * Deleting the title-bar icons meant deleting their CSS, and the deletion left an orphaned
 * declaration body behind — eleven lines of `min-width: 15px; …}` with no selector. **Every one of
 * 934 local test files passed.** The source guards in this repo read `master.css` as TEXT: they ask
 * which selector carries a declaration, whether a token is defined, whether a rung is ordered.
 * None of them asks whether the file is a stylesheet at all.
 *
 * It was caught by `vite build` on CI — `CssSyntaxError: Unexpected }` — which is three minutes of
 * runner time and a red branch for something a parse would have found in milliseconds.
 *
 * ## Why postcss and not a brace count
 *
 * Because postcss is what the build uses. A hand-rolled check would agree with the build until the
 * day it did not, and the whole point is to fail here for exactly the reasons the build fails.
 */

const STYLES = path.resolve(__dirname, '..');
const SHEETS = ['master.css', 'globals.css', 'tokens.css'];

describe('every stylesheet parses', () => {
    it('POSITIVE CONTROL: the parser rejects a broken sheet', () => {
        // Without this, a parse that silently tolerated anything would make every case below
        // pass against any file at all — which is the exact way the text-reading guards missed
        // this.
        expect(() => postcss.parse('.a { color: red; }\n    min-width: 15px;\n}', { from: 'x.css' }))
            .toThrow(/Unexpected \}/);
    });

    for (const sheet of SHEETS) {
        it(`${sheet} parses, and is not empty`, () => {
            const file = path.join(STYLES, sheet);
            const css = fs.readFileSync(file, 'utf8');
            // Non-empty first: a deleted or emptied sheet parses perfectly.
            expect(css.length, `${sheet} is suspiciously small`).toBeGreaterThan(200);
            expect(() => postcss.parse(css, { from: file })).not.toThrow();
        });
    }

    it('master.css still has the rules the app is built out of', () => {
        // A sheet can parse and be gutted. These are the three surfaces every window renders, so
        // their absence is not a style regression — it is a blank app.
        const css = fs.readFileSync(path.join(STYLES, 'master.css'), 'utf8');
        const root = postcss.parse(css, { from: 'master.css' });
        const selectors = new Set<string>();
        root.walkRules((rule) => {
            // A BLOCK body, not an expression: `walkRules`'s callback may return `false` to stop
            // walking, and `Set.add` returns the Set — so the arrow form ended the walk on the
            // first rule and this check passed against one selector.
            selectors.add(rule.selector);
        });
        for (const needed of ['.gwrap', '.deck', '.agent-view']) {
            expect([...selectors].some((s) => s.includes(needed)), `${needed} has no rule`).toBe(true);
        }
    });
});
