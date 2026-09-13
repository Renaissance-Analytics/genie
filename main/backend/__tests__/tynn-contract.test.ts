import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSync } from 'oxc-parser';
import { describe, expect, it } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';
import { TYNN_ENDPOINTS, normalizePath } from '../tynn-contract';

/**
 * The OFFLINE half of Genie's Tynn contract check — it runs on every `npm test`
 * and never touches the network.
 *
 * ## What this half is for
 *
 * `tynn-contract.live.test.ts` probes the real Tynn and fails when a route Genie
 * calls has been retired. That probe is only worth what the manifest it reads is
 * worth: a `TYNN_ENDPOINTS` that has drifted from the client checks endpoints
 * nobody calls, misses the ones that matter, and goes green either way. THIS
 * file is what keeps the two in step, by parsing Genie's own source and
 * comparing what it finds against what is declared.
 *
 * ## Why the source is PARSED, not grepped
 *
 * A regex over file text cannot tell a request path from a path named in a
 * comment — and `tynn.ts` deliberately names the retired `/api/v1/wishes` in its
 * own doc block, to explain why it is gone. Stripping comments with a span regex
 * is the trap recorded in RULES.md: a block-comment opener inside a string
 * blinds the regex, and the guard then reports "clean". A real parser has no such
 * failure mode — string and template literals come off the AST, and comments are
 * not in it. (It is oxc's: TypeScript 7 is a native compiler with no stable
 * JavaScript API to parse with.)
 *
 * ## Non-vacuity
 *
 * The rules are each other's positive control. "Every path in the source is
 * declared" would pass against a scanner that found nothing at all — which is
 * exactly what "every declared endpoint is present in its caller" fails on,
 * along with the explicit count assertion below.
 */

const REPO = path.resolve(__dirname, '../../..');

/** Roots searched for Tynn request paths. */
const SCANNED_ROOTS = ['main', 'renderer'];

/** Namespaces a Tynn request path can start with. */
const NAMESPACES = ['/api/v1', '/workstations'];

/**
 * Every request path a file could be building, as a normalized string.
 *
 * Template literals are reconstructed WHOLE, with each interpolation collapsed
 * to `{}` — so a path built from a base plus an id plus a suffix comes back as
 * `{}/api/v1/workstations/{}/broadcasting-auth` and lines up with the declared
 * path segment for segment. Reading the head, middle and tail separately
 * instead would leave a bare `/api/v1/workstations/` that matches almost
 * anything.
 */
function literalsOf(file: string): string[] {
    const { program, errors } = parseSync(file, fs.readFileSync(file, 'utf8'), {
        lang: file.endsWith('.d.ts') ? 'dts' : file.endsWith('.tsx') ? 'tsx' : 'ts',
    });
    // A file that does not parse would contribute no literals at all and read as
    // "calls nothing" — the vacuous pass this check exists to prevent.
    if (errors.length > 0) throw new Error(`${file} did not parse: ${errors[0]!.message}`);

    const out: string[] = [];
    const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (const child of node) visit(child);
            return;
        }
        if (!node || typeof node !== 'object') return;
        const n = node as { type?: string; value?: unknown; quasis?: Array<{ value: { cooked: string | null } }>; expressions?: unknown[] };
        if (n.type === 'Literal' && typeof n.value === 'string') {
            out.push(n.value);
            return;
        }
        if (n.type === 'TemplateLiteral' && n.quasis) {
            const [head, ...tail] = n.quasis;
            out.push((head?.value.cooked ?? '') + tail.map((q) => `{}${q.value.cooked ?? ''}`).join(''));
            // The interpolated expressions can hold literals of their own.
            visit(n.expressions);
            return;
        }
        for (const value of Object.values(node)) visit(value);
    };
    visit(program);
    return out;
}

function sourceFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Tests are excluded on purpose: a test naming a retired path is
                // how a retirement gets PINNED, not a call to it.
                if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
                walk(full);
                continue;
            }
            if (/\.tsx?$/.test(entry.name)) found.push(full);
        }
    };
    for (const root of SCANNED_ROOTS) walk(path.join(REPO, root));
    return found;
}

/**
 * Tynn request paths inside one literal.
 *
 * `/api/v1/…` is Tynn's own namespace and is unambiguous anywhere in the tree.
 * The workstation SESSION endpoints (`/workstations/connectable`,
 * `/workstations/{id}/connect-grant`) sit off that prefix, so they are matched
 * only at the START of a literal in the Tynn backend, where a leading relative
 * path is by definition a Tynn path.
 */
function tynnPathsIn(literal: string, file: string): string[] {
    const out: string[] = [];
    for (const m of literal.matchAll(/\/api\/v1(?:\/[A-Za-z0-9{}_.-]*)*/g)) out.push(m[0]);
    if (file === path.join(REPO, 'main', 'backend', 'tynn.ts')) {
        const m = /^\/workstations(?:\/[A-Za-z0-9{}_.-]*)*/.exec(literal);
        if (m) out.push(m[0]);
    }
    return out.map(normalizePath);
}

/**
 * A found path and a declared one agree when either is a prefix of the other.
 *
 * Prefix rather than equality because a path can be assembled across two
 * statements — `managed-credential-client.ts` builds the workstation prefix once
 * and appends `/provider-credentials` at each call site — and joining those
 * needs dataflow analysis this does not do. The `no path too vague` rule below
 * is what stops that slack from swallowing a genuinely unresolvable call.
 */
function matchesDeclared(found: string): boolean {
    return TYNN_ENDPOINTS.some((e) => {
        const declared = normalizePath(e.path);
        return declared.startsWith(found) || found.startsWith(declared);
    });
}

/** What is left of a path once its Tynn namespace is removed. */
function beyondNamespace(p: string): string {
    for (const ns of NAMESPACES) {
        if (p === ns || p.startsWith(`${ns}/`)) return p.slice(ns.length).replace(/^\/+/, '');
    }
    return p;
}

describe('the Tynn contract manifest tracks the client that uses it', () => {
    const scanned = sourceFiles().flatMap((file) =>
        literalsOf(file).flatMap((literal) =>
            tynnPathsIn(literal, file).map((found) => ({ file, found })),
        ),
    );
    const show = ({ file, found }: { file: string; found: string }): string =>
        `${found}  (${path.relative(REPO, file).replace(/\\/g, '/')})`;

    it('finds Tynn request paths at all — the control for every rule below', () => {
        // If the parser or the pattern breaks, this is the assertion that says
        // so, instead of the rules below passing over an empty list.
        expect(scanned.length).toBeGreaterThan(TYNN_ENDPOINTS.length);
    });

    it('declares every Tynn path Genie asks for', () => {
        const undeclared = [
            ...new Set(scanned.filter(({ found }) => !matchesDeclared(found)).map(show)),
        ].sort();
        expect(undeclared).toEqual([]);
    });

    it('leaves no path too vague to check', () => {
        // A call site that resolves to nothing more than the namespace
        // prefix-matches every declared endpoint, so it would pass the rule
        // above while being unprobeable. Dropping it quietly is how the live
        // check shrinks with nobody noticing.
        const vague = [
            ...new Set(scanned.filter(({ found }) => beyondNamespace(found) === '').map(show)),
        ].sort();
        expect(vague).toEqual([]);
    });

    it('declares nothing Genie has stopped calling', () => {
        const orphaned = TYNN_ENDPOINTS.filter((e) => {
            const file = path.join(REPO, e.caller);
            if (!fs.existsSync(file)) return true;
            const evidence = e.evidence ?? normalizePath(e.path).split('{')[0];
            return !literalsOf(file).some((l) => l.includes(evidence));
        }).map((e) => `${e.method} ${e.path} — claimed caller ${e.caller}`);
        expect(orphaned).toEqual([]);
    });
});

/**
 * The live probe is the half that can actually catch a retirement, and it runs
 * in its own lane — which means the ONLY thing making it ever run is a script
 * and a workflow. Delete either and nothing goes red: the unit suite stays
 * green, the contract stops being checked, and the failure mode is once again
 * "find out from a user". So the wiring is asserted like any other behaviour.
 */
/**
 * A YAML source with its comments removed, so a commented-out step cannot
 * satisfy an assertion about what the job actually runs.
 */
function withoutYamlComments(source: string): string {
    // Split on the LINE ENDING, not on `\n`. A CRLF file split on `\n` leaves a
    // `\r` at the end of every line, and `\r` is a line terminator in
    // JavaScript — so `.` cannot cross it, `.*$` never reaches the end, and not
    // one comment gets removed.
    return source
        .split(/\r?\n/)
        .map((line) => line.replace(/(^|\s)#.*$/, ''))
        .join('\n');
}

describe('the live half is wired to actually run', () => {
    const LIVE_TEST = 'main/backend/__tests__/tynn-contract.live.test.ts';
    const WORKFLOW = '.github/workflows/tynn-contract.yml';

    const workflow = withoutYamlComments(
        fs.readFileSync(path.join(REPO, WORKFLOW), 'utf8'),
    );

    // Loaded at run time rather than imported: the unit config is an ES module at
    // the repository root, and importing it would pull it into the main tree's
    // CommonJS typecheck, where `import.meta` is not allowed.
    const loadUnitConfig = async (): Promise<ViteUserConfig> =>
        ((await import(pathToFileURL(path.join(REPO, 'vitest.config.mts')).href)) as { default: ViteUserConfig })
            .default;

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
    };

    it('keeps the live probe OUT of the offline unit run', async () => {
        // Without this the unit suite would need the network, which is the one
        // thing the contract check is not allowed to cost.
        expect((await loadUnitConfig()).test?.exclude).toContain('**/*.live.test.ts');
    });

    it('has a lane that includes the live probe', () => {
        expect(fs.existsSync(path.join(REPO, LIVE_TEST))).toBe(true);
        expect(pkg.scripts['test:contract']).toContain('vitest.contract.config.mts');
    });

    it('runs that lane from CI, on a clock', () => {
        // On a clock because a route retirement is a commit in ANOTHER
        // repository — nothing pushed here can trigger the run that catches it.
        expect(workflow).toMatch(/^\s*schedule:/m);
        expect(workflow).toMatch(/^\s*- cron:/m);
        expect(workflow).toMatch(/run:\s*npm run test:contract/);
    });

    it('does not let the contract job pass when it fails', () => {
        // `continue-on-error` on this job would turn every retirement into a
        // green tick — the exact defect the whole check exists to prevent.
        expect(workflow).not.toMatch(/continue-on-error/);
    });
});

/**
 * The comment stripper, which the guard above is only as good as.
 *
 * It was written against `\n` and read a file that is `\r\n` on every Windows
 * checkout. `.` does not match `\r` — `\r` is a line terminator in JavaScript —
 * so `.*$` could never reach the end of a CRLF line and NO comment was ever
 * removed. The workflow says, in a comment, that it is *"Deliberately NOT
 * `continue-on-error`"*; the guard read that sentence as the setting and failed.
 *
 * Red on every Windows machine, green on CI's Linux runners, for a repository
 * whose owner works on Windows. A guard that fires on its own documentation is
 * worse than none: it teaches people that a red suite means nothing.
 */
describe('stripping YAML comments', () => {
    const yaml = (nl: string): string =>
        [
            'jobs:',
            '  contract:',
            '    # Deliberately NOT `continue-on-error`. Failing is the point.',
            '    steps:',
            '      - run: npm run test:contract',
        ].join(nl);

    it('removes a comment whichever way the file ends its lines', () => {
        for (const [name, nl] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
            expect({ name, out: withoutYamlComments(yaml(nl)) }).toEqual({
                name,
                out: expect.not.stringContaining('continue-on-error'),
            });
        }
    });

    it('leaves the settings themselves alone', () => {
        // POSITIVE CONTROL. Stripping is not the goal — catching a real
        // `continue-on-error` is, and a stripper that emptied the file would
        // pass the test above while making the guard permanently blind.
        for (const nl of ['\n', '\r\n']) {
            const out = withoutYamlComments(
                ['jobs:', '  contract:', '    continue-on-error: true'].join(nl),
            );
            expect(out).toContain('continue-on-error: true');
            expect(out).toMatch(/run:|jobs:/);
        }
    });

    it('takes a trailing comment without taking the setting before it', () => {
        const out = withoutYamlComments('    timeout-minutes: 10 # be generous\r\n');
        expect(out).toContain('timeout-minutes: 10');
        expect(out).not.toContain('be generous');
    });
});
