import { packageBaseName, parseTrackTag, type PackageTrack } from './track-manifest.js';
import { fingerprintAssetName } from './track-release-plan.js';
import { releaseTypeForTag, type UpdateChannel } from './update-channel.js';

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

/**
 * A TRACK'S DRAFT (Tynn #1058 L8): `<track>-v<build>`, made by release.yml's round for a track that changed
 * (core/track-release-plan.ts), checked by its `tracks-verify` job before the owner is asked to publish it. Each of the four
 * tracks (client, browser, host, launcher) is its own draft, of one of three kinds: the launcher (it replaces itself), a
 * window program (the client and the browser it runs on: no host restart), or the host (it ships with its client).
 *
 * - It is still a DRAFT, its notes have their "## What's new", and its tag is the one asked about.
 * - Every package the launcher's feed reads is there, for each platform the release builds: the archive, its manifest and
 *   the manifest's signature (an unsigned manifest is a missing `.sig`); and the track's fingerprint, which the next round
 *   compares with.
 * - NOTHING ELSE is there: a draft holding another track's package or a stray build file is refused.
 * - The prerelease flag is the channel's: a dev round's drafts are prereleases, a stable round's are not.
 */
export const RELEASE_PLATFORMS = [
    { platform: 'win32', arch: 'x64', archive: 'zip' },
    { platform: 'linux', arch: 'x64', archive: 'tar.zst' },
] as const;

/** The files a track's draft carries, in upload order (scripts/pack-track.mjs's names; the launcher's feed reads them). */
export function expectedTrackAssets(track: PackageTrack, build: string): string[] {
    const out: string[] = [];
    for (const p of RELEASE_PLATFORMS) {
        const stem = packageBaseName({ track, build, platform: p.platform, arch: p.arch });
        out.push(`${stem}.${p.archive}`, `${stem}.manifest.json`, `${stem}.manifest.json.sig`);
    }
    out.push(fingerprintAssetName(track, build));
    return out;
}

function notesProblem(view: ReleaseView, tag: string): string | null {
    const body = (view.body ?? '').trim();
    if (body === '') return `the notes are empty — docs/releases/${tag}.md did not reach the release`;
    if (!/^## What['’]s new\s*$/m.test(body)) return 'the notes have no "## What\'s new" section — the update window would show nothing';
    return null;
}

/** Every reason this track draft must not be offered for publishing; `[]` when it is complete. */
export function trackDraftProblems(view: ReleaseView, tag: string, channel: UpdateChannel): string[] {
    const t = parseTrackTag(tag);
    if (!t) return [`${tag} is not a track's release tag`];
    const problems: string[] = [];
    if (view.tagName !== tag) problems.push(`the release read is for tag ${view.tagName}, not ${tag}`);
    if (!view.isDraft) problems.push(`${tag} is not a draft — it is already public; this workflow never publishes`);
    const notes = notesProblem(view, tag);
    if (notes) problems.push(notes);
    const want = expectedTrackAssets(t.track, t.build);
    const have = new Set(view.assets.map((a) => a.name));
    for (const name of want) if (!have.has(name)) problems.push(`missing asset ${name}`);
    for (const a of view.assets) if (!want.includes(a.name)) problems.push(`${a.name} is not this track's — a ${t.track} ${t.build} draft carries its own packages only`);
    const wantPrerelease = channel === 'dev';
    if (view.isPrerelease !== wantPrerelease) {
        problems.push(`${tag} should ${wantPrerelease ? '' : 'NOT '}be a prerelease (it is${view.isPrerelease ? '' : ' not'}) — a ${channel} round's drafts are ${wantPrerelease ? '' : 'not '}prereleases`);
    }
    return problems;
}

/** Every kind of draft through one door: a track's tag by its track (with its round's channel), a `v*` tag as the app. */
export function releaseProblems(view: ReleaseView, tag: string, channel?: UpdateChannel): string[] {
    if (parseTrackTag(tag)) return channel ? trackDraftProblems(view, tag, channel) : [`${tag} is a track's draft: say its round's channel (--channel stable|dev)`];
    if (/^v\d/.test(tag)) return releaseDraftProblems(view, tag);
    return [`${tag} is not a release tag (v<version> or <track>-v<build>)`];
}
