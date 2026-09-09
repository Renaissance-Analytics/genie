import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
 *
 * ## Two failure modes, and the second one is worse
 *
 * `var(--x, #30343d)` DEGRADES: the fallback paints — permanently dark, in both
 * themes. `var(--x)` with no fallback does not degrade. It makes the whole
 * declaration **invalid at computed-value time**, and the declaration is
 * dropped. `background: color-mix(in srgb, var(--surface-2) 88%, transparent)`
 * on an undefined `--surface-2` is not "some background"; it is NO background.
 * genie#114 documented this once already, for `var(--shell)` in a portaled
 * overlay, where the Add-workspace modal showed straight through its own panel.
 *
 * genie#589 found 24 undefined tokens, 10 of them read with no fallback, which
 * left the agent cards and the terminal nudge notice with no background and no
 * border in EITHER theme. Every one would have failed this file on the day it
 * was written, which is the whole argument for the file.
 *
 * ## What counts as "defined"
 *
 * Anything a stylesheet declares (`--x: …`), plus anything the app sets on an
 * element at runtime — `style={{ '--x': … }}` in TSX, or `setProperty('--x', …)`.
 * `--ask-modal-width` is real and lives only in `renderer/pages/ask.tsx`; a guard
 * that could not see it would push a legitimate pattern out of the codebase.
 *
 * …and Tailwind's, because `globals.css` opens with `@import 'tailwindcss'` and
 * its `@theme default` block compiles to `:root`. Those tokens are as real as
 * Genie's own. Two names overlap today — `--shadow-lg` and `--shadow-xs` — and
 * that overlap is not academic: `var(--shadow-lg, 0 12px 32px …)` in the Flow
 * editor looked orphaned, but Tailwind's much lighter `--shadow-lg` was
 * resolving, so the fallback the author wrote had never once painted.
 *
 * Test files are deliberately NOT scanned for definitions: a guard a test can
 * satisfy by mentioning a token is not a guard.
 *
 * ## What this does NOT watch, and it is not a small gap
 *
 * READS are collected from `renderer/styles/*.css` only. Components read `var()`
 * inline too — `style={{ color: 'var(--zinc-500)' }}` — and 35 of those
 * declarations name a token nothing defines, 17 of them with no fallback. The
 * Question-inbox flyout, the first-run wizard, Workspace settings, the Ask modal
 * and Settings are all affected, and `--zinc-*` is among them, which is the very
 * thing the check below exists to stop: it evaded that check by not being in a
 * stylesheet. Inventoried in genie#592; widening `reads` to TSX is part of
 * fixing it, because the widened parse fails until the call sites are decided.
 *
 * ## Deliberately NOT asserted
 *
 * That every token flips between themes. `--term-bg` / `--term-head` / `--term-fg`
 * are defined once, dark, on `.gwrap, .genie-overlay-root`, and do not flip on
 * purpose — terminals and editors stay dark in both themes. Light ink on those
 * surfaces is correct, not a bug (genie#589 Class D).
 */

const ROOT = join(__dirname, '..', '..', '..');
const STYLES = join(ROOT, 'renderer', 'styles');

/** Directories whose TSX/TS may set a custom property on an element. */
const SOURCE_ROOTS = ['renderer', 'main'];

/** Blank comments out but KEEP the newlines, so reported line numbers are real. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * The same, for TS/TSX — and for the same reason the CSS parse strips first.
 *
 * A doc comment reading ``* `--genie-debug`: the startup log`` matches the
 * `'--x':` shape exactly, so `main/debug-log.ts` was DEFINING a CLI flag as a
 * CSS custom property. Prose about a token must not license using it.
 *
 * Only whole-line `//` comments are stripped, never a trailing one: `//` also
 * occurs inside string literals (`https://…`), and cutting to end-of-line there
 * could swallow a real definition further along the same line.
 */
const stripTsComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, '');

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, keep, out);
        else if (keep(entry)) out.push(full);
    }
    return out;
}

describe('Genie stylesheet tokens', () => {
    const sheets = walk(STYLES, (f) => f.endsWith('.css')).map((file) => ({
        name: file.slice(ROOT.length + 1).replace(/\\/g, '/'),
        css: stripComments(readFileSync(file, 'utf8')),
    }));

    /** `--x: value` in any stylesheet. */
    const definedInCss = sheets.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string));

    /** `style={{ '--x': … }}` and `el.style.setProperty('--x', …)` in app source. */
    const definedInSource = SOURCE_ROOTS.flatMap((root) =>
        walk(join(ROOT, root), (f) => f.endsWith('.ts') || f.endsWith('.tsx')).flatMap((file) => {
            const src = stripTsComments(readFileSync(file, 'utf8'));
            return [
                ...[...src.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map((m) => m[1] as string),
                ...[...src.matchAll(/['"`](--[\w-]+)['"`]\s*:/g)].map((m) => m[1] as string),
            ];
        }),
    );

    /** Tailwind's `@theme default`, which `globals.css` imports and which lands on `:root`. */
    const definedByTailwind = [
        ...stripComments(readFileSync(join(ROOT, 'node_modules', 'tailwindcss', 'theme.css'), 'utf8')).matchAll(
            /(--[\w-]+)\s*:/g,
        ),
    ].map((m) => m[1] as string);

    const defined = new Set([...definedInCss, ...definedInSource, ...definedByTailwind]);

    /** Every read, everywhere, tagged with the token, the site, and whether it can degrade. */
    const reads = sheets.flatMap(({ name, css }) =>
        [...css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)].map((m) => ({
            token: m[1] as string,
            where: `${name}:${lineOf(css, m.index as number)}`,
            hasFallback: m[2] === ',',
        })),
    );

    it('reads the palette it actually defines', () => {
        // The positive control: every assertion below is only meaningful if the
        // parse finds real tokens on BOTH sides. An empty `reads` or an empty
        // `defined` would make "nothing is undefined" pass on a corpse.
        expect(definedInCss).toContain('--bg-0');
        expect(definedInCss).toContain('--fg-1');
        expect(definedInCss).toContain('--border-1');
        expect(reads.map((r) => r.token)).toContain('--bg-0');
        expect(reads.length).toBeGreaterThan(200);

        // …and that the TSX half of the parse works, or a token set only from a
        // component reads as undefined and gets "fixed" into the stylesheet.
        expect(definedInSource).toContain('--ask-modal-width');
        expect(definedInSource).toContain('--nq');

        // …and that it reads CODE, not prose. `--genie-debug` is a CLI flag that
        // two doc comments mention in backticks followed by a colon — which is
        // the `'--x':` shape — so before comments were stripped this list
        // "defined" it. The negative control for the positive ones above.
        expect(definedInSource).not.toContain('--genie-debug');

        // …and that Tailwind's theme was actually found and parsed. If the file
        // ever moves, this fails HERE — rather than the orphan check quietly
        // narrowing to Genie's own sheets and passing anyway.
        expect(definedByTailwind).toContain('--shadow-lg');
        expect(definedByTailwind.length).toBeGreaterThan(100);
    });

    it('never dresses a fixed colour up as a theme token', () => {
        // `--zinc-*` is Tailwind's scale, not Genie's. Reading one means the
        // fallback is what paints — in both themes.
        const offenders = reads
            .filter((r) => r.token.startsWith('--zinc-'))
            .map((r) => `${r.where}: var(${r.token}, …)`);
        expect(offenders).toEqual([]);
    });

    it('never reads a custom property with NO fallback that nothing defines', () => {
        // The loud one. No fallback + undefined = the DECLARATION is dropped, so
        // the element renders with no background, no border, no colour at all, in
        // both themes. That is a rendering defect, not a theming preference.
        const voided = reads
            .filter((r) => !r.hasFallback && !defined.has(r.token))
            .map((r) => `${r.where}  var(${r.token})  → DECLARATION VOID`);
        expect(voided).toEqual([]);
    });

    it('keeps every status ink readable on its own ground, in BOTH themes', () => {
        // The -400 inks are TEXT — "Read failed", "Reconnect GitHub", the pulse
        // markers, the What's-new kicker. Each is a pair precisely because one
        // mid-tone cannot serve both grounds, so the pair is only worth having
        // if each half actually clears AA against the surface it lands on.
        //
        // Values are read from the sheet, not restated here: a test that carries
        // its own copy of the palette passes after someone edits the palette.
        const scope = (selector: string) => {
            const css = sheets.find((s) => s.name.endsWith('globals.css'))!.css;
            const open = css.indexOf(`${selector} {`);
            return css.slice(open, css.indexOf('\n}', open));
        };
        const valueIn = (block: string, token: string) =>
            new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1] ?? '';

        const themes = [
            { name: 'light', block: scope(':root') },
            { name: 'dark', block: scope('.dark') },
        ];
        const INKS = ['--amber-400', '--amber-300', '--yellow-400', '--emerald-400', '--rose-400', '--violet-400'];

        const luminance = (hex: string) => {
            const channels = [1, 3, 5]
                .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
                .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        };
        const contrast = (a: string, b: string) => {
            const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
        };

        // Positive control: the parse found real hex values, and the two themes
        // are genuinely different. Without this, an ink that failed to parse
        // would compare '' against '' and the whole check would be a no-op.
        const grounds = themes.map((t) => valueIn(t.block, '--bg-1'));
        expect(grounds).toEqual(['#fafafa', '#18181b']);

        const failures: string[] = [];
        for (const [index, theme] of themes.entries()) {
            for (const ink of INKS) {
                const value = valueIn(theme.block, ink);
                expect(value, `${ink} has no ${theme.name} half`).toMatch(/^#[0-9a-f]{6}$/i);
                const ratio = contrast(value, grounds[index]);
                if (ratio < 4.5) failures.push(`${theme.name} ${ink} ${value} on ${grounds[index]} = ${ratio.toFixed(2)}:1`);
            }
        }
        expect(failures).toEqual([]);
    });

    it('pins the tokens master.css redefines OUT of the light/dark mechanism', () => {
        // `globals.css` declares a pair in `:root` + `.dark`; `master.css` then
        // redeclares the same name on `.gwrap, .genie-overlay-root`, which is
        // more specific and has no dark counterpart. The pair stops flipping,
        // and it does so silently — the token IS defined, so the guards above
        // are happy.
        //
        // The two below are KNOWN and tracked, not accepted. `--card` is 19
        // surfaces (the toolbar project selector, the upgrade modal, popovers,
        // prompt inputs) all painting #17171d under `--fg-1` text, which in the
        // light theme is near-black ink on a near-black card. Fixing it also
        // means giving the AgentInbox roster's own `--ai-*` inks light halves,
        // which is why it is its own change rather than a line in genie#589.
        //
        // This is here so the list cannot GROW without someone saying so.
        const globals = sheets.find((s) => s.name.endsWith('globals.css'))!.css;
        const master = sheets.find((s) => s.name.endsWith('master.css'))!.css;
        const namesIn = (css: string, from: number, to: number) =>
            new Set([...css.slice(from, to).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string));

        const darkAt = globals.indexOf('.dark {');
        const light = namesIn(globals, globals.indexOf(':root {'), darkAt);
        const dark = namesIn(globals, darkAt, globals.indexOf('\n}', darkAt));
        const pairs = [...light].filter((t) => dark.has(t));
        expect(pairs).toContain('--bg-0'); // positive control: pairs were found

        const redefined = new Set([...master.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string));
        expect(pairs.filter((t) => redefined.has(t)).sort()).toEqual(['--card', '--shadow-xs']);
    });

    it('never reads a custom property nothing defines', () => {
        // The wider one. WITH a fallback the page still paints — but it paints the
        // literal, which in this codebase is always the dark-theme value, so the
        // rule is permanently dark and only looks themed.
        const orphans = [...new Set(reads.filter((r) => !defined.has(r.token)).map((r) => r.token))].sort();
        const detail = orphans.map(
            (token) =>
                `${token} → ${reads
                    .filter((r) => r.token === token)
                    .map((r) => r.where)
                    .join(', ')}`,
        );
        expect(detail).toEqual([]);
    });
});
