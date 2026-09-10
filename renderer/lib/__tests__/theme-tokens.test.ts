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
 * genie#589 found 23 tokens the sheets read and Genie never declares: 22 that
 * nothing defines at all, plus `--shadow-lg`, which only Tailwind does. NINE of
 * the 22 were read with no fallback anywhere, voiding 22 declarations — which is
 * why the agent cards, the terminal nudge notice and the agent panel's head had
 * no background and no border in EITHER theme. Every one would have failed this
 * file on the day it was written, which is the whole argument for the file.
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
 * Genie's own, and what Tailwind quietly supplies has now caught two changes
 * out:
 *
 *   · `var(--shadow-lg, 0 12px 32px …)` in the Flow editor looked orphaned. It
 *     was not — Tailwind's much lighter `--shadow-lg` was resolving, so the
 *     fallback the author wrote had never once painted (genie#589).
 *   · `--radius-sm` and `--ease-out` looked like they needed moving out of
 *     `.gwrap` alongside `--radius-full`. They did not, and re-declaring
 *     `--ease-out` would have swapped Tailwind's curve for Genie's in every
 *     non-master window — a regression introduced BY a bug fix, in a property
 *     nobody would think to check (genie#595).
 *
 * **When in doubt, grep the BUILT stylesheet, not the source.** Tailwind's
 * contribution does not appear anywhere in `renderer/styles/`; the only place it
 * is visible is `renderer/.next/static/css/*.css` after `npx next build
 * renderer`. Both findings above came from reading that file, not this one.
 *
 * Test files are deliberately NOT scanned for definitions: a guard a test can
 * satisfy by mentioning a token is not a guard.
 *
 * ## Reads come from BOTH surfaces (genie#592)
 *
 * Components read `var()` inline — `style={{ color: 'var(--zinc-500)' }}` — and
 * for a while this file did not look there. 35 such declarations named a token
 * nothing defines, 17 with no fallback, across the Question-inbox flyout, the
 * first-run wizard, Workspace settings, the Ask modal and Settings. Six were
 * `--zinc-*`, which the check below has guarded against since the toolchain
 * wizard: they evaded it purely by living in a `.tsx`. So `reads` now walks
 * `renderer/**` and `main/**` as well as the stylesheets.
 *
 * ## Being DEFINED is not the same as being IN SCOPE (genie#595)
 *
 * Everything above compares flat sets, and custom properties INHERIT. A token
 * declared on `.agentinbox-flyout` does not exist for an element outside one,
 * and reading it there fails exactly like reading an undeclared token. Two
 * checks below cover the two shapes this takes:
 *
 *   · a scope-local family read from outside the family that owns it — how
 *     `.repo-panel-error` came to read `--ai-red`, so the repo panel's error
 *     text was never red and its notice never green;
 *   · `globals.css` reading a token only `master.css` declares — `globals.css`
 *     styles every window, `.gwrap` is only the master one, so `.site-dot`'s
 *     `border-radius: var(--radius-full)` was dropped in Settings and its status
 *     dots rendered as SQUARES there while drawing circles in the master window.
 *
 * Neither is visible to a "is this token defined anywhere?" check, and both fail
 * the way this whole file is about: the declaration is dropped, silently.
 *
 * ### The rule, which is what generalises — not the two instances
 *
 * **`master.css` styles the MASTER window. `globals.css` styles EVERY window.**
 * `.gwrap` is `pages/master.tsx`'s wrapper, and Ask, Settings, Docs, Capture,
 * GApp and Mobile mount no `.gwrap` — so a token declared there does not exist
 * for them. Two ways to get this wrong, and this repo has now shipped both:
 *
 *   · `.gwrap` SHADOWING a `globals.css` pair, so the token stops flipping —
 *     `--card` was `#17171d` under `--fg-1` `#18181b`, 1.01:1, invisible text on
 *     31 declarations (genie#591);
 *   · `globals.css` READING a `.gwrap`-only token, so the declaration is dropped
 *     in every other window — `.site-dot` drew circles in master and 8×8 squares
 *     in Settings (genie#595).
 *
 * They are mirror images of one seam. Both were invisible while everyone ran
 * dark, and neither degrades — each drops a declaration outright. A token that
 * belongs to more than the master window belongs in `globals.css`.
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

    const varRead = /var\(\s*(--[\w-]+)\s*([,)])/g;

    /** Every read in a stylesheet. */
    const cssReads = sheets.flatMap(({ name, css }) =>
        [...css.matchAll(varRead)].map((m) => ({
            token: m[1] as string,
            where: `${name}:${lineOf(css, m.index as number)}`,
            hasFallback: m[2] === ',',
        })),
    );

    /**
     * …and every read in a COMPONENT — `style={{ color: 'var(--zinc-500)' }}`.
     *
     * genie#592: leaving these out made the guard narrower than its name. 35
     * declarations named a token nothing defines, 17 with NO fallback, and six
     * of them were `--zinc-*` — the exact thing the check below has guarded
     * against since the toolchain-wizard fix. They evaded it purely by living in
     * a `.tsx` rather than a `.css`.
     */
    const sourceReads = SOURCE_ROOTS.flatMap((root) =>
        walk(join(ROOT, root), (f) => f.endsWith('.ts') || f.endsWith('.tsx')).flatMap((file) => {
            const src = stripTsComments(readFileSync(file, 'utf8'));
            return [...src.matchAll(varRead)].map((m) => ({
                token: m[1] as string,
                where: `${file.slice(ROOT.length + 1).replace(/\\/g, '/')}:${lineOf(src, m.index as number)}`,
                hasFallback: m[2] === ',',
            }));
        }),
    );

    /** Every read, everywhere, tagged with the token, the site, and whether it can degrade. */
    const reads = [...cssReads, ...sourceReads];

    it('reads the palette it actually defines', () => {
        // The positive control: every assertion below is only meaningful if the
        // parse finds real tokens on BOTH sides. An empty `reads` or an empty
        // `defined` would make "nothing is undefined" pass on a corpse.
        expect(definedInCss).toContain('--bg-0');
        expect(definedInCss).toContain('--fg-1');
        expect(definedInCss).toContain('--border-1');
        expect(reads.map((r) => r.token)).toContain('--bg-0');
        expect(reads.length).toBeGreaterThan(200);

        // …and that BOTH read surfaces were walked. A stylesheet-only parse is
        // what let genie#592's 35 declarations through, so an empty component
        // side has to fail here rather than silently narrow the checks below.
        expect(cssReads.length).toBeGreaterThan(200);
        expect(sourceReads.length).toBeGreaterThan(50);
        expect(sourceReads.map((r) => r.token)).toContain('--fg-3');

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
        const INKS = [
            '--amber-400',
            '--amber-300',
            '--yellow-400',
            '--emerald-400',
            '--rose-400',
            '--violet-400',
            '--cyan-400',
        ];

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

    it('keeps every SURFACE readable under the primary ink, in BOTH themes', () => {
        // The other half of the same arithmetic, and the one genie#591 was.
        //
        // `--fg-1` is what `.gwrap` sets and therefore what almost everything
        // inherits, so a ground the app paints is only usable if `--fg-1` reads
        // on it. `--card` was `#17171d` in BOTH themes while `--fg-1` correctly
        // flipped to `#18181b`, which is **1.01:1** — not dim text, invisible
        // text, on 31 declarations including the toolbar project selector, every
        // `.input`, the popovers and the upgrade modal. `--shell` was 1.09:1 and
        // `--rail` 1.05:1 on the same reasoning.
        //
        // Reading both halves out of `globals.css` is what makes this assertion
        // possible at all: a surface declared once, outside a theme scope, has no
        // "light value" to measure — which is exactly why it was unmeasured.
        const scope = (selector: string) => {
            const css = sheets.find((s) => s.name.endsWith('globals.css'))!.css;
            const open = css.indexOf(`${selector} {`);
            return css.slice(open, css.indexOf('\n}', open));
        };
        const valueIn = (block: string, token: string) =>
            new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1] ?? '';
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

        /** Every token the sheets use as a background people read text on. */
        const SURFACES = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--card', '--card-hover', '--shell', '--rail'];

        const themes = [
            { name: 'light', block: scope(':root') },
            { name: 'dark', block: scope('.dark') },
        ];

        // Positive control: the ink itself parsed, and it genuinely differs
        // between the themes. Comparing '' to '' would pass every row below.
        const inks = themes.map((t) => valueIn(t.block, '--fg-1'));
        expect(inks).toEqual(['#18181b', '#fafafa']);

        const failures: string[] = [];
        for (const [index, theme] of themes.entries()) {
            for (const surface of SURFACES) {
                const value = valueIn(theme.block, surface);
                expect(
                    value,
                    `${surface} has no ${theme.name} half in globals.css — a surface declared ` +
                        `outside :root/.dark cannot flip, and cannot be measured either`,
                ).toMatch(/^#[0-9a-f]{6}$/i);
                const ratio = contrast(value, inks[index]);
                if (ratio < 4.5) {
                    failures.push(`${theme.name} ${surface} ${value} under --fg-1 ${inks[index]} = ${ratio.toFixed(2)}:1`);
                }
            }
        }
        expect(failures).toEqual([]);
    });

    it('never reads a SCOPE-LOCAL token from outside the family that owns it', () => {
        // genie#595. Everything above compares two flat sets — "is this token
        // declared anywhere?" — and CSS custom properties do not work that way.
        // They INHERIT, so a token declared on `.agentinbox-flyout` does not
        // exist for an element that is not inside one, and reading it there
        // fails exactly like reading an undeclared token: the declaration goes
        // invalid at computed-value time and is dropped.
        //
        // That is how `.repo-panel-error` came to read `--ai-red`. Both tokens
        // were defined, so every check above passed, and the repo panel's error
        // text was never red and its notice never green — for as long as the
        // panel has existed. `master.css` even carries a comment warning that
        // these tokens "resolve to nothing" outside the AgentInbox; the rule was
        // documented and then broken by a component reaching over the fence.
        //
        // ## Why ownership, and not ancestry
        //
        // The obvious check — "does the reading selector look like a descendant
        // of a declaring one?" — cannot be computed from a stylesheet. Tried
        // against this repo it flags 85 false positives: `.agentinbox-brand` IS
        // inside `.agentinbox-flyout`, and no amount of string comparison
        // between those two selectors knows it.
        //
        // So the rule is OWNERSHIP, declared here: a scope-local token belongs
        // to a family, and only that family may read it. One line per family,
        // no DOM model, and the convention already held everywhere except the
        // bug. A new scope-local family with no entry FAILS — which is the point:
        // it makes someone say who owns the token instead of letting it drift.
        const OWNERS: Record<string, string> = {
            // `--ai-*` are the AgentInbox's local palette (master.css ~5356).
            '--ai-': '.agentinbox',
            // Set by `.agent-panel-shell.agent-provider-*`, read by the panel
            // and its head — all `.agent-panel*`.
            '--agent-accent': '.agent-panel',
            // Per-item index on the nudge dots, set on the element that uses it.
            '--nq': '.agent-nudge-questions',
        };

        /**
         * Scopes every element inherits from, so a token declared in one of them
         * is reachable anywhere and is NOT scope-local. `.gwrap` and the overlay
         * host are here because genie#114 made them a matched pair on purpose.
         */
        const GLOBAL = new Set([':root', '.dark', 'html', 'body', '.gwrap', '.genie-overlay-root', '.m-app', '.m-pair']);

        /** Top-level rules of a sheet as `{ selectors, body }`. */
        const rulesOf = (css: string) => {
            const out: { selectors: string[]; body: string; line: number }[] = [];
            const re = /^([^@\s}][^{}]*)\{([^{}]*)\}/gm;
            for (let m = re.exec(css); m; m = re.exec(css)) {
                out.push({
                    selectors: m[1].split(',').map((s) => s.trim()),
                    body: m[2],
                    line: lineOf(css, m.index as number),
                });
            }
            return out;
        };

        const rules = sheets.flatMap(({ name, css }) => rulesOf(css).map((r) => ({ ...r, file: name })));

        /** token -> the selectors that declare it. */
        const declaredOn = new Map<string, Set<string>>();
        for (const r of rules) {
            for (const m of r.body.matchAll(/(--[\w-]+)\s*:/g)) {
                if (!declaredOn.has(m[1])) declaredOn.set(m[1], new Set());
                for (const s of r.selectors) declaredOn.get(m[1])!.add(s);
            }
        }

        /** Declared, but nowhere every element can see. */
        const scopeLocal = [...declaredOn].filter(([, sels]) => ![...sels].some((s) => GLOBAL.has(s))).map(([t]) => t);

        const ownerOf = (token: string) =>
            Object.entries(OWNERS).find(([prefix]) => token === prefix || token.startsWith(prefix))?.[1];

        // Resolved ONCE. The trespass scan runs per `var()` across every rule in
        // an 8,000-line sheet, and this test lives in the default `npm test` run.
        const owners = new Map(scopeLocal.map((t) => [t, ownerOf(t)] as const));

        // Positive control: the parse found rules, found declarations, and found
        // the scope-local family this test exists for. Without it a regex that
        // matched nothing would make every assertion below vacuously true.
        expect(rules.length).toBeGreaterThan(500);
        expect(scopeLocal).toContain('--ai-red');
        expect(scopeLocal).not.toContain('--bg-0');

        // Every scope-local token names an owner. This is what fails when a new
        // component invents a local palette and says nothing about it.
        expect(scopeLocal.filter((t) => !ownerOf(t)).sort()).toEqual([]);

        const trespass = rules.flatMap((r) =>
            [...r.body.matchAll(/var\(\s*(--[\w-]+)\s*[,)]/g)].flatMap((m) => {
                const owner = owners.get(m[1]);
                if (!owner) return [];
                return r.selectors
                    .filter((sel) => !sel.includes(owner))
                    .map((sel) => `${r.file}:${r.line}  ${sel} reads ${m[1]}, which only ${owner}* may read`);
            }),
        );
        expect([...new Set(trespass)].sort()).toEqual([]);
    });

    it('never lets globals.css read a token only master.css declares', () => {
        // The same scope bug as above, one level up, and it is live.
        //
        // `master.css` styles the MASTER window: `.gwrap` is `pages/master.tsx`'s
        // wrapper and `.genie-overlay-root` is its portal host. `globals.css`
        // styles EVERY window — Ask, Settings, Docs, Capture, GApp, Mobile — none
        // of which mount `.gwrap`. So a `globals.css` rule that reads a token
        // only `.gwrap` declares works in the master window and is DROPPED
        // everywhere else, which is why it survives review: whoever added it saw
        // it working.
        //
        // Found by this test: `.site-dot` reads `border-radius:
        // var(--radius-full)`, and Settings renders three of them — so the status
        // dots beside the runtime, the probe and the engine were 8×8 SQUARES
        // there while being round in the master window. `.gh-code`'s transition
        // read `--dur-fast` / `--ease-out` and did not animate.
        //
        // Fallbacks are excluded on purpose: `var(--x, 6px)` cannot go blank, so
        // it is not a scope dependency. Same reasoning overlay-layers.test.ts
        // uses for genie#114, which is this bug in the other direction.
        const globals = sheets.find((s) => s.name.endsWith('globals.css'))!.css;
        const master = sheets.find((s) => s.name.endsWith('master.css'))!.css;
        const declaredIn = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string));

        const inGlobals = declaredIn(globals);
        const inMaster = declaredIn(master);
        const reachable = new Set([...inGlobals, ...definedInSource, ...definedByTailwind]);

        // Positive control: both sheets parsed, and they really do declare
        // different things — otherwise "nothing is master-only" is trivially true.
        expect(inGlobals.has('--bg-0')).toBe(true);
        expect(inMaster.has('--term-bg')).toBe(true);
        expect([...inMaster].some((t) => !reachable.has(t))).toBe(true);

        const escaped = [...globals.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
            .map((m) => ({ token: m[1] as string, line: lineOf(globals, m.index as number) }))
            .filter((r) => !reachable.has(r.token))
            .map((r) => `renderer/styles/globals.css:${r.line} reads ${r.token}, declared only in master.css`);
        expect([...new Set(escaped)].sort()).toEqual([]);
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
        expect(pairs.filter((t) => redefined.has(t)).sort()).toEqual([]);
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
