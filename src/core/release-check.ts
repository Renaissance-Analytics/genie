import { releaseTypeForTag } from './update-channel.js';

/**
 * WHAT A RELEASE MUST BE BEFORE THE OWNER IS ASKED TO PUBLISH IT (the owner, 2026-10-22, on beta.38's update window:
 * "why the fuck was beta 38 published with no release notes and how was this able to get past our CI?").
 *
 * `.github/workflows/release.yml` builds every platform into ONE DRAFT; its last job, `verify`, writes the notes and
 * then reads the draft back (`gh release view --json tagName,isDraft,isPrerelease,body,assets`) and refuses it unless
 * every check below holds. `scripts/verify-release-draft.ts` is the step; `test/release-draft.test.ts` holds both.
 *
 * - It is still a DRAFT. `verify` never publishes; a public release found here is the incident itself.
 * - The notes are there and have their "## What's new" — the section the update window shows (core/whats-new.ts).
 * - Every file an updater reads is there: the Windows installer, its blockmap and `latest.yml`; the Linux AppImage and
 *   `latest-linux.yml`. beta.35 and beta.37 went public with the Linux pair only.
 * - The prerelease flag is what the tag says (`releaseTypeForTag`): a suffixed tag is for the dev channel only.
 */
export interface ReleaseView {
    tagName: string;
    isDraft: boolean;
    isPrerelease: boolean;
    body: string | null;
    assets: ReadonlyArray<{ name: string }>;
}

/** The files the two updaters read, by electron-builder.yml's artifact names (win `${productName}-${version}-setup.${ext}`). */
export function expectedReleaseAssets(version: string): string[] {
    return [
        `Genie-${version}-setup.exe`,
        `Genie-${version}-setup.exe.blockmap`,
        'latest.yml',
        `Genie-${version}.AppImage`,
        'latest-linux.yml',
    ];
}

/** Every reason this draft must not be offered for publishing; `[]` when it is complete. */
export function releaseDraftProblems(view: ReleaseView, tag: string): string[] {
    const problems: string[] = [];
    const version = tag.replace(/^v/, '');
    if (view.tagName !== tag) problems.push(`the release read is for tag ${view.tagName}, not ${tag}`);
    if (!view.isDraft) problems.push(`${tag} is not a draft — it is already public; this workflow never publishes`);
    const body = (view.body ?? '').trim();
    if (body === '') problems.push(`the notes are empty — docs/releases/${tag}.md did not reach the release`);
    else if (!/^## What['’]s new\s*$/m.test(body)) problems.push(`the notes have no "## What's new" section — the update window would show nothing`);
    const have = new Set(view.assets.map((a) => a.name));
    for (const name of expectedReleaseAssets(version)) {
        if (!have.has(name)) problems.push(`missing asset ${name}`);
    }
    const wantPrerelease = releaseTypeForTag(tag) === 'prerelease';
    if (view.isPrerelease !== wantPrerelease) {
        problems.push(`${tag} should ${wantPrerelease ? '' : 'NOT '}be a prerelease (it is${view.isPrerelease ? '' : ' not'}) — the update channel follows this flag`);
    }
    return problems;
}
