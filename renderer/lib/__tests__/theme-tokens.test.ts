import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GENIE'S PALETTE IS `--bg-N` / `--fg-N` / `--border-N`, and those are the only
 * colours that flip between the light and dark themes.
 *
 * A rule written as `var(--zinc-800, #27272a)` looks theme-aware and is not:
 * Genie defines no `--zinc-*` scale anywhere, so the custom property never
 * resolves and the hard-coded dark-theme fallback paints in BOTH themes. The
 * first-run toolchain wizard picked up three of these — its plan list's border
 * and row separators, and the "already installed" chips — which is why its panel
 * carries near-black hairlines on the light theme, where every other surface
 * draws a faint one.
 *
 * A dead `var()` is invisible: it does not warn, it does not fail a build, and
 * it renders as *something*, so it survives review. Hence a test rather than a
 * comment.
 */

const STYLES = join(__dirname, '..', '..', 'styles');
const SHEETS = ['globals.css', 'master.css'] as const;

/**
 * Every `var(--name` the sheet reads, and every `--name:` it defines.
 *
 * Comments are stripped first, or a note EXPLAINING a token counts as using it —
 * which is how this test first failed on its own fix.
 */
function tokens(css: string) {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const read = [...rules.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] as string);
    const defined = [...rules.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string);
    return { read, defined };
}

describe('Genie stylesheet tokens', () => {
    const sheets = SHEETS.map((name) => ({
        name,
        css: readFileSync(join(STYLES, name), 'utf8'),
    }));
    const defined = new Set(sheets.flatMap((s) => tokens(s.css).defined));

    it('reads the palette it actually defines', () => {
        // The positive control: this assertion is only meaningful if the parse
        // finds real tokens on both sides.
        expect(defined.has('--bg-0')).toBe(true);
        expect(defined.has('--fg-1')).toBe(true);
        expect(defined.has('--border-1')).toBe(true);
        expect(sheets.some((s) => tokens(s.css).read.includes('--bg-0'))).toBe(true);
    });

    it('never dresses a fixed colour up as a theme token', () => {
        // `--zinc-*` is Tailwind's scale, not Genie's. Reading one means the
        // fallback is what paints — in both themes.
        const offenders = sheets.flatMap(({ name, css }) =>
            tokens(css)
                .read.filter((t) => t.startsWith('--zinc-'))
                .map((t) => `${name}: var(${t}, …)`),
        );
        expect(offenders).toEqual([]);
    });

});

/*
 * NOT asserted here, deliberately: that EVERY custom property the sheets read is
 * defined. Widening this parse to all of them finds a dozen more dead ones
 * (`--accent`, `--fg-5`, `--mono`, `--green-500`, `--red-500`, `--amber-300/400`,
 * `--rose-400`, `--violet-400`, `--blue-400`, `--accent-2`) scattered across
 * surfaces this change does not touch. Each needs a colour decision by whoever
 * owns that surface, and picking them here would be a redesign smuggled into a
 * timeout fix. Raised separately; the `--zinc-*` guard above is the part this
 * change earns.
 */
