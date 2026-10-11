import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE RELEASE WORKFLOW — the one place a Genie 2 build may leave this repo, and the rules it
 * must keep so that nothing ships by accident and what ships lands where installed copies look.
 *
 * - It runs ONLY for a `v*` tag. A push to `main` must build (ci.yml) and never publish: four
 *   betas of the previous build shipped on green suites, and the owner's rule is that a tag is
 *   a deliberate, approved act — "merge passing work; tags need a nod".
 * - It publishes with a token that can write the OLD repo's releases (`GENIE_RELEASE_TOKEN`),
 *   because `GITHUB_TOKEN` is scoped to this repository and the feed every installed Genie
 *   carries points at `Renaissance-Analytics/genie` (test/upgrade.test.ts holds that half).
 * - It publishes as a prerelease, which is what `allowPrerelease` on the updater side expects.
 *
 * Read as text on purpose: a workflow is configuration with no runtime short of GitHub, and the
 * failure modes here are a string somebody changes without reading the comment next to it.
 */
const workflow = () => readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');
const ci = () => readFileSync('.github/workflows/ci.yml', 'utf8').replace(/\r\n/g, '\n');

describe('the release workflow', () => {
    it('exists', () => {
        expect(workflow().length).toBeGreaterThan(200);
    });

    it('runs only for a v* tag — never on a push to a branch, never on a schedule', () => {
        const on = workflow().match(/^on:\n([\s\S]*?)\n\S/m)?.[1] ?? '';
        expect(on).toMatch(/tags:\s*\n\s*-\s*['"]?v\*/);
        expect(on).not.toMatch(/branches:/);
        expect(on).not.toMatch(/schedule:/);
        expect(on).not.toMatch(/pull_request/);
    });

    it('publishes to GitHub with the cross-repo token, as a real publish', () => {
        expect(workflow()).toMatch(/GH_TOKEN:\s*\$\{\{\s*secrets\.GENIE_RELEASE_TOKEN\s*\}\}/);
        expect(workflow()).toMatch(/--publish always/);
        expect(workflow()).not.toMatch(/--publish never/);
    });

    it('refuses to run when the tag does not match package.json — a tag is a claim about a version', () => {
        expect(workflow()).toMatch(/package\.json/);
        expect(workflow()).toMatch(/GITHUB_REF_NAME|github\.ref_name/);
    });

    it('builds every platform the previous Genie shipped — Windows, Linux, macOS', () => {
        for (const os of ['windows-latest', 'ubuntu-latest', 'macos-latest']) expect(workflow()).toContain(os);
    });

    it('CONTROL: ci.yml still never publishes', () => {
        // The positive control for the first assertion's intent: the workflow that DOES run on
        // every push is the one that must keep `--publish never`, and must not know the token.
        expect(ci()).toMatch(/--publish never/);
        expect(ci()).not.toMatch(/GENIE_RELEASE_TOKEN/);
        expect(ci()).not.toMatch(/--publish always/);
    });
});
