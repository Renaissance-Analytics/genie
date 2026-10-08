import fs from 'node:fs';
import path from 'node:path';
import { notesVerdict, checkReleaseNotes, policyAppliesTo } from './release-notes-policy.mjs';

/**
 * ASK BEFORE TAGGING: does this tag have notes that pass the gate?
 *
 * `npm run release:check v0.7.0-beta.343`
 *
 * `release.yml` already answers this correctly and safely — `prepare-release` gates the platform
 * builds through `needs:`, so a missing file fails in about twenty seconds with nothing built or
 * published. This exists because that answer arrives AFTER a tag has been pushed, and a tag is the
 * one step in the release that is awkward to take back.
 *
 * It runs the same two checks the workflow runs, in the same order, so a pass here means the
 * workflow's first job will pass. It changes nothing and publishes nothing.
 */
const DIR = 'docs/releases';
const tag = process.argv[2];

const available = fs.existsSync(DIR) ? fs.readdirSync(DIR) : [];
const verdict = notesVerdict(tag, available);
console.log(verdict.message);
if (!verdict.ok) process.exit(1);

// The SAME policy gate the workflow applies, so a pass here is a pass there.
const file = path.join(DIR, `v${String(tag).trim().replace(/^v/i, '')}.md`);
if (policyAppliesTo(path.basename(file))) {
    const problems = checkReleaseNotes(fs.readFileSync(file, 'utf8'));
    if (problems.length > 0) {
        console.error(`
${file} fails the release-notes policy:`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
    }
    console.log('Notes pass the length policy.');
}
console.log(`
Ready: pushing tag v${String(tag).trim().replace(/^v/i, '')} will find its notes.`);
