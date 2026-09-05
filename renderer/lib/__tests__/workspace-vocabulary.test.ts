import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The main UX does not teach the storage format (genie#432).
 *
 * Genie stores a workspace as an Aionima `.agi` envelope. That is true, it is
 * documented, and it is the right word in `docs/` and in code. It is the wrong
 * word in the product: the Add-workspace modal HEADED itself "Upgrade to .agi
 * envelope", so the first thing a new user read while making their first
 * workspace was a term that explains nothing and implies their project is
 * somehow deficient. The owner: "I don't want to see the term AGI envelop or
 * upgrade to agi anywhere in the main ux, that stuff is just noise that will
 * confuse end users and should be in docs only."
 *
 * ## What is forbidden, and what deliberately is not
 *
 * Forbidden in text a user reads: the noun "envelope", the verb "upgrade" (on
 * the workspace surfaces — an app UPDATE is a different thing and lives
 * elsewhere), and a bare capitalised "AGI".
 *
 * NOT forbidden: `.agi` inside a concrete name. A workspace folder really is
 * called `acme.agi` on disk and its container repository really is called
 * `acme.agi` on GitHub, and #432 asks for "a fact to reflect, not a mode to
 * pick or a name to teach". Showing someone the path they are about to get is
 * reflecting the fact. Heading a screen with the format is teaching it.
 *
 * ## Why it reads the source
 *
 * There is no DOM harness in this lane (see `vitest.config.ts`), so the strings
 * are lifted out of the .tsx rather than off a rendered tree. The extractor is
 * itself tested below — a negative assertion whose scanner silently sees
 * nothing passes on a corpse, and this repo has been burned by exactly that
 * (`provider-literal-guard.test.ts` documents the span-regex version of the
 * mistake).
 */

const RENDERER = path.resolve(__dirname, '../..');

const read = (rel: string) => fs.readFileSync(path.join(RENDERER, rel), 'utf8');

/**
 * The file with comments and import paths removed.
 *
 * LINE-BASED, matching `provider-literal-guard.test.ts`: a block-comment SPAN
 * regex cannot tell a real comment from a slash-star inside a string literal,
 * and when it guesses wrong it deletes arbitrary lines from the scan and then
 * reports the file clean. Comments must go because the comments here explain
 * the format on purpose — the sentence that stops the next reader
 * reintroducing the vocabulary must not be the thing that fails the build.
 *
 * Import paths go too: `from './InteractiveUpgradeWizard'` is a module name, and
 * the component's NAME is code, which #432 leaves alone.
 */
function codeOnly(src: string): string {
    return src
        .split('\n')
        .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
        .filter((line) => !/^\s*import\b/.test(line))
        .join('\n');
}

/**
 * Every quoted literal in a fragment of source, minus the operands of an
 * equality test. `label={route.stage === 'tynn-envelope' ? 'Choose location' :
 * …}` displays "Choose location"; `'tynn-envelope'` is a state name being
 * compared, which is code, and #432 leaves code alone.
 */
function literals(fragment: string): string[] {
    const scrubbed = fragment.replace(/[=!]==?\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '');
    return [...scrubbed.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]!);
}

/** The braced expression starting at `open`, balanced. */
function braced(src: string, open: number): string {
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(open + 1, i);
        }
    }
    return src.slice(open + 1);
}

/** JSX/prop props whose value the user reads. `className` and `name` are not. */
const DISPLAY_PROPS = 'label|title|description|desc|sub|subtitle|placeholder|body|heading|aria-label';

/**
 * Everything in the file that reaches a human's eyes: JSX text between tags,
 * the display props above (quoted, or braced so a ternary's arms are seen),
 * thrown Error messages, and literals bound to a name that says it is copy.
 */
export function userVisibleText(src: string): string[] {
    const code = codeOnly(src);
    const out: string[] = [];

    // JSX text: a span between tags with no braces or angle brackets in it, so
    // `>{expr}<` and `a > b && c < d` cannot masquerade as prose.
    for (const m of code.matchAll(/>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) out.push(m[1]!);

    // Display props, quoted: label="…"
    for (const m of code.matchAll(new RegExp(`\\b(?:${DISPLAY_PROPS})=(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'g'))) {
        out.push(m[2]!);
    }

    // Display props, braced: label={busy ? 'Working…' : 'Create workspace'}
    for (const m of code.matchAll(new RegExp(`\\b(?:${DISPLAY_PROPS})=\\{`, 'g'))) {
        out.push(...literals(braced(code, m.index! + m[0]!.length - 1)));
    }

    // Error text is UI too — it is what the user gets when the flow fails.
    for (const m of code.matchAll(/new Error\(([^)]*)\)/g)) out.push(...literals(m[1]!));

    // `const finishLabel = cond ? 'A' : 'B'` — copy that reaches a prop later.
    for (const m of code.matchAll(
        /\b(?:const|let|var)\s+\w*(?:label|title|text|msg|message|heading|copy|body)\w*\s*=\s*([^;\n]*(?:\n\s+[^;\n]*)*);/gi,
    )) {
        out.push(...literals(m[1]!));
    }

    return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The workspace surfaces a user meets while making or living in a workspace. */
const WORKSPACE_SURFACES = [
    'components/AddWorkspaceModal.tsx',
    'components/InteractiveUpgradeWizard.tsx',
    'components/WorkspaceList.tsx',
    'components/Master/Chooser.tsx',
    'components/Master/WorkspaceSettingsModal.tsx',
    'components/Master/FirstRunOnboarding.tsx',
];

/** Where the Add-workspace flow itself lives — the screen #432 opens on. */
const ADD_WORKSPACE_SURFACES = [
    'components/AddWorkspaceModal.tsx',
    'components/InteractiveUpgradeWizard.tsx',
];

describe('the extractor these guards stand on', () => {
    const FIXTURE = [
        "import Thing from './UpgradeWizard';",
        '/**',
        ' * A doc comment that says envelope on purpose.',
        ' */',
        'function Demo() {',
        "    const glob = '/*.agi'; // an envelope glob, not a comment",
        "    const finishLabel = busy ? 'Working…' : 'Build envelope';",
        '    return (',
        '        <div className="upgrade-tbl">',
        '            Plain prose about an envelope.',
        '            <Field label="Envelope slug" placeholder="acme" />',
        '            <Action label={busy ? \'Wait\' : \'Upgrade\'} />',
        "            <Footer label={stage === 'tynn-envelope' ? 'Choose location' : 'Import'} />",
        '            {count > 2 && <span>{envelopeName}</span>}',
        '        </div>',
        '    );',
        '}',
    ].join('\n');

    const seen = userVisibleText(FIXTURE);

    it('sees prose, quoted props, braced props, and copy variables', () => {
        expect(seen).toContain('Plain prose about an envelope.');
        expect(seen).toContain('Envelope slug');
        expect(seen).toContain('Upgrade');
        expect(seen).toContain('Build envelope');
    });

    it('is not blinded by a slash-star living inside a string', () => {
        // The span-regex version of this scanner swallowed every line from the
        // `'/*.agi'` literal to the next real `*/` and called the file clean.
        expect(seen.join(' | ')).toMatch(/Build envelope/);
    });

    it('leaves code alone — class names, identifiers, module paths, comments', () => {
        const joined = seen.join(' | ');
        expect(joined).not.toMatch(/upgrade-tbl/);
        expect(joined).not.toMatch(/UpgradeWizard/);
        expect(joined).not.toMatch(/envelopeName/);
        expect(joined).not.toMatch(/on purpose/);
    });

    it('reads the arms of a ternary, not the state name it tests', () => {
        expect(seen).toContain('Choose location');
        expect(seen.join(' | ')).not.toMatch(/tynn-envelope/);
    });
});

describe('workspace UX vocabulary (genie#432)', () => {
    for (const rel of WORKSPACE_SURFACES) {
        it(`${rel} never calls a workspace an envelope`, () => {
            const offenders = userVisibleText(read(rel)).filter((s) => /\benvelopes?\b/i.test(s));
            expect(offenders).toEqual([]);
        });

        it(`${rel} never says "AGI" at a user`, () => {
            const offenders = userVisibleText(read(rel)).filter((s) => /\bAGI\b/.test(s));
            expect(offenders).toEqual([]);
        });
    }

    for (const rel of ADD_WORKSPACE_SURFACES) {
        it(`${rel} does not offer to "upgrade" anything`, () => {
            // Making a workspace is not a remedial act. The word survives in the
            // component's file name and CSS classes, which are code.
            const offenders = userVisibleText(read(rel)).filter((s) => /\bupgrade/i.test(s));
            expect(offenders).toEqual([]);
        });
    }
});
