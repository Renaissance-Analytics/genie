/**
 * The last step of .github/workflows/release.yml (`verify`): read the draft back and refuse it unless it is complete
 * (src/core/release-check.ts). Exit 1 names every problem as a workflow error; the draft stays a draft either way.
 *
 * Usage: npx tsx scripts/verify-release-draft.ts <tag> <release.json>
 *   release.json = `gh release view <tag> --json tagName,isDraft,isPrerelease,body,assets`
 */
import { readFileSync } from 'node:fs';
import { releaseDraftProblems, type ReleaseView } from '../src/core/release-check.js';

const tag = process.argv[2] ?? '';
const file = process.argv[3] ?? '';
if (!tag || !file) {
    console.log('::error::usage: verify-release-draft.ts <tag> <release.json>');
    process.exit(2);
}
const view = JSON.parse(readFileSync(file, 'utf8')) as ReleaseView;
const problems = releaseDraftProblems(view, tag);
if (problems.length > 0) {
    for (const p of problems) console.log(`::error::${p}`);
    console.log(`${tag}: NOT ready to publish (${problems.length} problem${problems.length === 1 ? '' : 's'}). It stays a draft.`);
    process.exit(1);
}
console.log(`${tag}: a complete draft — notes with "What's new", ${view.assets.length} assets, prerelease ${view.isPrerelease}.`);
console.log(`Publish it only on the owner's approval: gh release edit ${tag} -R Renaissance-Analytics/genie --draft=false`);
