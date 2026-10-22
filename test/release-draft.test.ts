import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectedReleaseAssets, releaseDraftProblems, type ReleaseView } from '../src/core/release-check.js';

/**
 * NO RELEASE IS PUBLIC WITHOUT ITS NOTES (the owner, 2026-10-22, on beta.38's update window saying "No release notes were
 * published for this update": "why the fuck was beta 38 published with no release notes and how was this able to get past
 * our CI?").
 *
 * Measured: each platform job ran `electron-builder --publish always` straight into a PUBLIC prerelease, and the notes
 * job ran after both. beta.38 was public with an empty body for ~7 minutes (ubuntu 02:17:46Z → notes 02:24:21Z) and an
 * updater that looked in that window kept the empty answer. beta.35 and beta.37: the Windows job failed, `notes` was
 * skipped, and both stayed public with empty bodies and Linux-only assets.
 *
 * The flow now: `guard` creates ONE draft (prerelease flag by the tag, notes from docs/releases/<tag>.md); every platform
 * job uploads into that draft (electron-publish returns an existing draft for the tag whatever the publish type, and
 * `EP_DRAFT` makes any release it would CREATE a draft); `verify`, after every platform succeeded, re-writes the notes
 * and checks notes + assets + flags. Nothing un-drafts: publishing is the owner's own step after his approval.
 */
const raw = () => readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');
/** The workflow without its full-line comments: what RUNS (the comments may name the owner's publish command). */
const code = (text = raw()) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
/** One job's text, from `  <id>:` to the next job at the same indent. */
function job(id: string, text = code()): string {
    const start = text.indexOf(`\n  ${id}:\n`);
    expect(start, `job ${id}`).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}
const builder = () => readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');

describe('the release workflow publishes a DRAFT first', () => {
    it('guard creates the one draft — prerelease by the tag, notes from the file — with contents: write', () => {
        const guard = job('guard');
        expect(guard).toMatch(/contents:\s*write/);
        expect(guard).toContain('case "$tag" in *-*) prerelease=--prerelease ;; *) prerelease= ;; esac');
        expect(guard).toMatch(/gh release create "\$GITHUB_REF_NAME"[^\n]*--draft/);
        expect(guard).toMatch(/gh release create "\$GITHUB_REF_NAME"[^\n]*--verify-tag/);
        expect(guard).toMatch(/gh release create "\$GITHUB_REF_NAME"[^\n]*\$prerelease/);
        expect(guard).toMatch(/gh release create "\$GITHUB_REF_NAME"[^\n]*--notes-file "docs\/releases\/\$GITHUB_REF_NAME\.md"/);
    });

    it('guard reuses a draft that exists and REFUSES a release for the tag that is already public', () => {
        const guard = job('guard');
        // A second `gh release create --draft` would make a SECOND draft for the same tag (drafts do not collide).
        expect(guard).toMatch(/gh release view "\$GITHUB_REF_NAME"[^\n]*--json isDraft/);
        expect(guard).toMatch(/::error::[^\n]*already public/);
    });

    it('every platform job publishes with EP_DRAFT — electron-publish\'s highest-precedence switch — and nothing turns it off', () => {
        const publish = job('publish');
        expect(publish).toMatch(/EP_DRAFT:\s*'true'/);
        expect(publish).toMatch(/npx electron-builder --publish always/);
        // EP_PRE_RELEASE would be read AFTER EP_DRAFT, but no step may set it, nor pick a public type on the command line.
        expect(code()).not.toMatch(/EP_PRE_?RELEASE/);
        expect(code()).not.toMatch(/--config\.publish\.releaseType=(?!draft\b)/);
    });

    it('electron-builder.yml itself defaults to a draft — a publish from anywhere else is not public either', () => {
        expect(builder()).toMatch(/^\s*releaseType:\s*draft\s*$/m);
        expect(builder()).not.toMatch(/^\s*releaseType:\s*(prerelease|release)\s*$/m);
    });

    it('NOTHING in the workflow un-drafts — that is the owner\'s step, and the comment names the command', () => {
        expect(code()).not.toMatch(/--draft[= ]false/);
        expect(code()).not.toMatch(/draft["']?\s*:\s*false/);
        expect(code()).not.toMatch(/gh release edit[^\n]*--draft(?!=true)/);
        // POSITIVE CONTROL: the patterns do see an un-draft — the documented command is in the COMMENTS.
        // (`-R`, not `--repo`: test/release-workflow.test.ts refuses `--repo Renaissance-Analytics/` anywhere in the file.)
        expect(raw()).toMatch(/gh release edit <tag> -R Renaissance-Analytics\/genie --draft=false/);
        expect(raw()).toMatch(/--draft=false/);
    });

    it('verify runs only after EVERY platform job succeeded — no always(), no continue-on-error', () => {
        const verify = job('verify');
        expect(verify).toMatch(/needs:\s*\[?\s*publish\b/);
        expect(verify).not.toMatch(/^\s*if:/m);
        expect(code()).not.toMatch(/continue-on-error/);
        expect(code()).not.toMatch(/always\(\)/);
        // `needs: publish` covers every leg of the matrix: both platforms are legs of the one job.
        const publish = job('publish');
        for (const os of ['windows-latest', 'ubuntu-latest']) expect(publish).toContain(os);
    });

    it('verify writes the notes from the file, then checks notes + assets + flags with the release-check script', () => {
        const verify = job('verify');
        expect(verify).toMatch(/contents:\s*write/);
        expect(verify).toMatch(/gh release edit "\$\{\{ github\.ref_name \}\}" --repo "\$\{\{ github\.repository \}\}" --notes-file "docs\/releases\/\$\{\{ github\.ref_name \}\}\.md"/);
        expect(verify).toMatch(/gh release view "\$\{\{ github\.ref_name \}\}" --repo "\$\{\{ github\.repository \}\}" --json tagName,isDraft,isPrerelease,body,assets > release\.json/);
        expect(verify).toMatch(/scripts\/verify-release-draft\.ts "\$\{\{ github\.ref_name \}\}" release\.json/);
        // The edit comes BEFORE the read it is checked by.
        expect(verify.indexOf('--notes-file')).toBeLessThan(verify.indexOf('verify-release-draft.ts'));
    });

    it('closing shipped issues waits for the owner\'s publish: release-published.yml, not the draft run', () => {
        expect(code()).not.toMatch(/close-shipped/);
        const pub = readFileSync('.github/workflows/release-published.yml', 'utf8').replace(/\r\n/g, '\n');
        expect(pub).toMatch(/^on:\n\s+release:\n\s+types:\s*\[\s*published\s*\]/m);
        expect(code(pub)).toMatch(/scripts\/close-shipped\.ts "\$\{\{ github\.event\.release\.tag_name \}\}"/);
        expect(pub).toMatch(/issues:\s*write/);
    });
});

describe('releaseDraftProblems — what verify refuses', () => {
    const v = '2.0.0-beta.39';
    const notes = `# Genie ${v}\n\n## What's new\n\n- something\n`;
    const good = (over: Partial<ReleaseView> = {}): ReleaseView => ({
        tagName: `v${v}`,
        isDraft: true,
        isPrerelease: true,
        body: notes,
        assets: expectedReleaseAssets(v).map((name) => ({ name })),
        ...over,
    });

    it('names the five assets the updaters read', () => {
        expect(expectedReleaseAssets(v)).toEqual([
            `Genie-${v}-setup.exe`,
            `Genie-${v}-setup.exe.blockmap`,
            'latest.yml',
            `Genie-${v}.AppImage`,
            'latest-linux.yml',
        ]);
    });

    it('a complete draft passes (POSITIVE CONTROL for every refusal below)', () => {
        expect(releaseDraftProblems(good(), `v${v}`)).toEqual([]);
    });

    it('refuses an empty or whitespace body, and a body without "## What\'s new"', () => {
        expect(releaseDraftProblems(good({ body: '' }), `v${v}`)).toEqual([expect.stringMatching(/notes are empty/)]);
        expect(releaseDraftProblems(good({ body: '  \n' }), `v${v}`)).toEqual([expect.stringMatching(/notes are empty/)]);
        expect(releaseDraftProblems(good({ body: null }), `v${v}`)).toEqual([expect.stringMatching(/notes are empty/)]);
        expect(releaseDraftProblems(good({ body: '# notes\n\nsome text' }), `v${v}`)).toEqual([expect.stringMatching(/What's new/)]);
    });

    it('names every missing asset — the beta.35/37 shape (Linux only) fails with the three Windows files', () => {
        const linuxOnly = good({ assets: [{ name: `Genie-${v}.AppImage` }, { name: 'latest-linux.yml' }] });
        const problems = releaseDraftProblems(linuxOnly, `v${v}`);
        expect(problems).toHaveLength(3);
        for (const f of [`Genie-${v}-setup.exe`, `Genie-${v}-setup.exe.blockmap`, 'latest.yml']) {
            expect(problems.some((p) => p.includes(f))).toBe(true);
        }
    });

    it('refuses a release that is already public — verify never publishes, and finding one public is the incident', () => {
        expect(releaseDraftProblems(good({ isDraft: false }), `v${v}`)).toEqual([expect.stringMatching(/not a draft/)]);
    });

    it('the prerelease flag follows the tag: a suffixed tag is a prerelease, a plain one is not', () => {
        expect(releaseDraftProblems(good({ isPrerelease: false }), `v${v}`)).toEqual([expect.stringMatching(/prerelease/)]);
        const stable = '2.0.0';
        const plain: ReleaseView = { tagName: `v${stable}`, isDraft: true, isPrerelease: false, body: notes, assets: expectedReleaseAssets(stable).map((name) => ({ name })) };
        expect(releaseDraftProblems(plain, `v${stable}`)).toEqual([]);
        expect(releaseDraftProblems({ ...plain, isPrerelease: true }, `v${stable}`)).toEqual([expect.stringMatching(/prerelease/)]);
    });

    it('refuses a release for a different tag', () => {
        expect(releaseDraftProblems(good({ tagName: 'v2.0.0-beta.38' }), `v${v}`)).toEqual([expect.stringMatching(/tag/)]);
    });
});
