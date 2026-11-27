/**
 * The last step of .github/workflows/release.yml (`verify` for the app, `tracks-verify` for each track's draft): read the
 * draft back and refuse it unless it is complete (src/core/release-check.ts). Exit 1 names every problem as a workflow
 * error; the draft stays a draft either way.
 *
 * Usage: npx tsx scripts/verify-release-draft.ts <tag> <release.json> [--channel stable|dev]
 *   release.json = `gh release view <tag> --json tagName,isDraft,isPrerelease,body,assets`
 *   --channel     a track's draft (<track>-v<build>): its round's channel, which its prerelease flag follows
 */
import { readFileSync } from 'node:fs';
import { releaseProblems, type ReleaseView } from '../src/core/release-check.js';
import { channelFrom, type UpdateChannel } from '../src/core/update-channel.js';

const [tag = '', file = '', ...rest] = process.argv.slice(2);
const at = rest.indexOf('--channel');
const channelArg = at >= 0 ? rest[at + 1] : undefined;
if (!tag || !file || (at >= 0 && channelArg !== 'stable' && channelArg !== 'dev')) {
    console.log('::error::usage: verify-release-draft.ts <tag> <release.json> [--channel stable|dev]');
    process.exit(2);
}
const channel: UpdateChannel | undefined = channelArg === undefined ? undefined : channelFrom(channelArg);
const view = JSON.parse(readFileSync(file, 'utf8')) as ReleaseView;
const problems = releaseProblems(view, tag, channel);
if (problems.length > 0) {
    for (const p of problems) console.log(`::error::${p}`);
    console.log(`${tag}: NOT ready to publish (${problems.length} problem${problems.length === 1 ? '' : 's'}). It stays a draft.`);
    process.exit(1);
}
console.log(`${tag}: a complete draft — notes with "What's new", ${view.assets.length} assets, prerelease ${view.isPrerelease}.`);
console.log(`Publish it only on the owner's approval: gh release edit ${tag} -R Renaissance-Analytics/genie --draft=false`);
