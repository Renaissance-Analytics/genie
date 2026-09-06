import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The `master-window` hook may only wait for overlays the MASTER ROUTE can render.
 *
 * genie#356. `master-window.spec.ts`'s `beforeAll` dismisses whatever first-run
 * layers happen to be up before the tests start driving the window. Each is a
 * `waitFor({ timeout: 20_000 }).catch(() => {})` followed by `if (count)`, which
 * is the right shape for a modal that MAY appear — and the wrong shape for one
 * that cannot, because it then burns its full 20 seconds on every run and the
 * guard clause never fires. Two of the three were doing exactly that:
 *
 *   - `Getting the Workstation Ready` — `FirstRunOnboarding` has had no mount
 *     site since it was superseded by the Genie OS layer, so the walkthrough
 *     cannot render anywhere.
 *   - `.toolchain-wizard` — `78cdd904` ("hard-cut onboarding and native AMS")
 *     removed the `ToolchainSetupWizard` mount from `master.tsx`. Its only
 *     remaining mount is `settings.tsx`, a DIFFERENT route, so it cannot render
 *     in this harness either. That commit edited this very spec and left the
 *     wait behind.
 *
 * 40 fixed seconds of a 60-second hook, which is why a hook measured at ~42s on
 * a green run had 18s of headroom and lost it the moment anything varied
 * (genie#490, genie#442).
 *
 * WHY THIS IS A UNIT TEST AND NOT AN E2E: the E2E cannot see it. A wait whose
 * element never appears and a wait whose element appears late are the same
 * green. The spec behaves identically whether the overlay exists or not — that
 * is the whole defect — so the only place the two can be told apart is here,
 * against the source. Same argument the `e2e/helpers` vitest lane already makes
 * for the launch wait-for-exit in `vitest.config.ts`.
 *
 * The third wait, `.whats-new-backdrop`, IS reachable and is the POSITIVE
 * CONTROL: it keeps this test honest. A module walk that silently resolved
 * nothing, or a literal extractor that found nothing, would report the two real
 * violations AND this one — so a run in which only the genuine offenders fail is
 * evidence that both halves of the scan work.
 */

const REPO = path.resolve(__dirname, '..', '..', '..');
const SPEC = path.join(REPO, 'e2e', 'master-window.spec.ts');
const MASTER_ROUTE = path.join(REPO, 'renderer', 'pages', 'master.tsx');

/**
 * Is this line CODE, or a comment?
 *
 * Line-based on purpose (genie#404). The span regex `/\/\*[\s\S]*?\*\//` that
 * this kind of guard reaches for first matches the earliest `/*` anywhere —
 * including one inside a string literal — and deletes everything to the next
 * `*\/`, so it can blind the rest of a file and then report it clean. Deciding
 * one line at a time cannot do that: the worst case is one line misjudged.
 */
function isComment(line: string): boolean {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** The body of the spec's `beforeAll`, as lines, comments removed. */
function beforeAllBody(): string[] {
    const lines = fs.readFileSync(SPEC, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes('test.beforeAll('));
    const end = lines.findIndex((l) => l.includes('test.afterAll('));
    expect(start, 'master-window.spec.ts should have a beforeAll').toBeGreaterThan(-1);
    expect(end, 'master-window.spec.ts should have an afterAll').toBeGreaterThan(start);
    return lines.slice(start, end).filter((l) => !isComment(l));
}

/**
 * Every literal the hook waits for, as a string that must appear in the source
 * of whatever renders it: a `hasText` phrase, or a class name from a
 * `.locator('.foo')`.
 */
function waitedForLiterals(): string[] {
    const out = new Set<string>();
    for (const line of beforeAllBody()) {
        for (const m of line.matchAll(/hasText:\s*'([^']+)'/g)) out.add(m[1]!);
        for (const m of line.matchAll(/\.locator\('\.([A-Za-z0-9_-]+)'\)/g)) out.add(m[1]!);
    }
    return [...out];
}

const EXTS = ['.tsx', '.ts'];

/** Resolve a RELATIVE import specifier to a file on disk, or null. */
function resolveRelative(fromFile: string, spec: string): string | null {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [
        base,
        ...EXTS.map((e) => base + e),
        ...EXTS.map((e) => path.join(base, 'index' + e)),
    ]) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            /* not this one */
        }
    }
    return null;
}

/**
 * Every source file reachable from the master route by relative imports.
 *
 * Route-aware on purpose. "Is this component mounted ANYWHERE" is the wrong
 * question and would have called `ToolchainSetupWizard` mounted — it is, from
 * `settings.tsx`, which the master harness never loads. What decides whether an
 * overlay can appear in THIS window is whether the thing that renders it is in
 * THIS route's graph.
 */
function masterRouteGraph(): string[] {
    const seen = new Set<string>();
    const queue = [MASTER_ROUTE];
    while (queue.length) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const src = fs.readFileSync(file, 'utf8');
        for (const line of src.split(/\r?\n/)) {
            if (isComment(line)) continue;
            for (const m of line.matchAll(/from\s*'(\.[^']*)'/g)) {
                const next = resolveRelative(file, m[1]!);
                if (next && !seen.has(next)) queue.push(next);
            }
        }
    }
    return [...seen];
}

/**
 * Which FILE renders each thing the hook looks for.
 *
 * Declared, not inferred. The first draft of this guard asked the weaker
 * question "does the literal appear anywhere in the route graph", and
 * `Getting the Workstation Ready` PASSED it — the phrase is also a step title in
 * `renderer/lib/workspace-onboarding.ts:166`, a data table the master route does
 * import. A string in a data constant is not a component that renders it, so the
 * guard would have reported the exact defect it was written for as clean.
 *
 * The two tests below make the map honest in both directions: every wait must
 * have an entry (so it cannot go stale by omission) and every entry must really
 * contain its literal (so it cannot go stale by pointing somewhere convenient).
 */
const RENDERED_BY: Record<string, string> = {
    'Getting the Workstation Ready': 'renderer/components/Master/FirstRunOnboarding.tsx',
    'toolchain-wizard': 'renderer/components/Master/ToolchainSetupWizard.tsx',
    'whats-new-backdrop': 'renderer/pages/master.tsx',
    'genie-os-layer': 'renderer/pages/master.tsx',
};

describe('the master-window hook waits only for overlays the master route can render', () => {
    const graph = masterRouteGraph();
    const literals = waitedForLiterals();

    it('walks a real module graph', () => {
        // POSITIVE CONTROL for the walk. Every assertion below is of the form
        // "this file is absent", and absence passes beautifully against an empty
        // graph — so the graph has to be shown non-trivial first.
        expect(graph.length).toBeGreaterThan(20);
        expect(graph).toContain(MASTER_ROUTE);
    });

    it('extracts the literals the hook actually looks for', () => {
        // POSITIVE CONTROL for the extractor, for the same reason: one that
        // found nothing would report every wait legal.
        expect(literals.length).toBeGreaterThan(0);
    });

    it('knows what renders every one of them', () => {
        for (const literal of literals) {
            expect(
                RENDERED_BY[literal],
                `master-window.spec.ts looks for "${literal}" and this guard does not know ` +
                    `what renders it. Add it to RENDERED_BY — an unmapped wait is an unchecked one.`,
            ).toBeTruthy();
        }
    });

    it.each(Object.entries(RENDERED_BY))('%s really is rendered by %s', (literal, file) => {
        // Without this, a mapping could point at any file that happens to be in
        // the graph and every wait would pass.
        expect(fs.readFileSync(path.join(REPO, file), 'utf8')).toContain(literal);
    });

    it.each(literals)('%s is renderable on the master route', (literal) => {
        const file = path.join(REPO, RENDERED_BY[literal] ?? 'renderer/pages/master.tsx');
        expect(
            graph.includes(file),
            `master-window.spec.ts waits 20s for "${literal}", rendered by ` +
                `${RENDERED_BY[literal]} — which nothing reachable from renderer/pages/master.tsx ` +
                `imports. The wait always times out and the dismissal behind it can never run ` +
                `(genie#356). Either mount what renders it, or drop the wait.`,
        ).toBe(true);
    });
});
