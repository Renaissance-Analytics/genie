import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TYNN_ENDPOINTS, normalizePath } from '../tynn-contract';
import unitConfig from '../../../vitest.config';

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
 * blinds the regex, and the guard then reports "clean". TypeScript's parser has
 * no such failure mode — string and template literals come off the AST, and
 * comments are not in it.
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
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        /* setParentNodes */ false,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            out.push(node.text);
            return;
        }
        if (ts.isTemplateExpression(node)) {
            out.push(
                node.head.text + node.templateSpans.map((s) => `{}${s.literal.text}`).join(''),
            );
            // The interpolated expressions can hold literals of their own.
            for (const span of node.templateSpans) visit(span.expression);
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
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
describe('the live half is wired to actually run', () => {
    const LIVE_TEST = 'main/backend/__tests__/tynn-contract.live.test.ts';
    const WORKFLOW = '.github/workflows/tynn-contract.yml';

    /** The workflow with YAML comments removed, so a commented-out step cannot
     *  satisfy an assertion about what the job runs. */
    const workflow = fs
        .readFileSync(path.join(REPO, WORKFLOW), 'utf8')
        .split('\n')
        .map((line) => line.replace(/(^|\s)#.*$/, ''))
        .join('\n');

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
    };

    it('keeps the live probe OUT of the offline unit run', () => {
        // Without this the unit suite would need the network, which is the one
        // thing the contract check is not allowed to cost.
        expect(unitConfig.test?.exclude).toContain('**/*.live.test.ts');
    });

    it('has a lane that includes the live probe', () => {
        expect(fs.existsSync(path.join(REPO, LIVE_TEST))).toBe(true);
        expect(pkg.scripts['test:contract']).toContain('vitest.contract.config.ts');
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
