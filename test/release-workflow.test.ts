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

describe('release notes', () => {
    /**
     * A release without notes is a version number. The owner's go for the first beta came
     * with a condition — the known limitations listed in the release notes — and v1's own
     * release rule was the same (no notes, no build). So: a non-dev version REQUIRES
     * `docs/releases/v<version>.md`, the workflow refuses a tag without it, and after the
     * publish the workflow writes that file into the GitHub release body.
     */
    const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

    it('exist for the version in package.json whenever that version is not the dev placeholder', () => {
        if (version === '0.0.0') return; // dev tree: no release, no notes required
        const notes = readFileSync(`docs/releases/v${version}.md`, 'utf8');
        expect(notes.length).toBeGreaterThan(500);
        expect(notes).toContain(version);
        // The condition the owner attached to the go: the limitations are IN the notes.
        expect(notes).toMatch(/Known limitations/i);
    });

    it('are guarded by the workflow and written into the release', () => {
        const wf = workflow();
        expect(wf).toMatch(/docs\/releases\/v\$\{?[A-Za-z_]*\}?\.md|docs\/releases\//);
        expect(wf).toMatch(/gh release edit/);
        expect(wf).toMatch(/--notes-file/);
    });
});
