import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    RELEASE_NOTES_LIMITS,
    RELEASE_NOTES_POLICY_FROM,
    checkReleaseNotes,
    policyAppliesTo,
} from '../release-notes-policy.mjs';

/**
 * Release notes must be SHORT — genie#325.
 *
 * The What's New popover and the upgrade log render `docs/releases/v*.md`
 * verbatim (via the GitHub release body). Bullets had grown into 400-character
 * paragraphs, and the owner's complaint is exactly that: *"People don't want
 * to read novels."* A limit nobody enforces is a preference; this makes it a
 * gate, in `npm test` (so it fails at PR time) and again in `release.yml`
 * before the release is created.
 */

const dir = path.resolve('docs/releases');

describe('the limits', () => {
    const long = `- ${'x'.repeat(RELEASE_NOTES_LIMITS.bulletChars + 20)}`;

    it('flags a bullet longer than the limit, and says which and by how much', () => {
        const problems = checkReleaseNotes(`## What’s new\n\n${long}\n`);

        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(new RegExp(String(RELEASE_NOTES_LIMITS.bulletChars)));
    });

    it('accepts a bullet exactly at the limit', () => {
        // Boundary, and a POSITIVE CONTROL for the test above: an off-by-one
        // here would make the limit quietly stricter than it documents.
        const exact = `- ${'x'.repeat(RELEASE_NOTES_LIMITS.bulletChars - 2)}`;
        expect(exact.length).toBe(RELEASE_NOTES_LIMITS.bulletChars);

        expect(checkReleaseNotes(`## What’s new\n\n${exact}\n`)).toEqual([]);
    });

    it('flags a file with too many bullets', () => {
        const many = Array.from({ length: RELEASE_NOTES_LIMITS.bullets + 1 }, (_, i) => `- ${i}`);
        const problems = checkReleaseNotes(`## What’s new\n\n${many.join('\n')}\n`);

        expect(problems.join(' ')).toMatch(/bullet/i);
    });

    it('flags a file that is simply too long overall', () => {
        // Many short bullets is still a novel. Caps the whole thing, not just
        // its parts.
        const filler = Array.from({ length: 4 }, () => `- ${'y'.repeat(190)}`).join('\n');
        const problems = checkReleaseNotes(`## What’s new\n\n${filler}\n${'z'.repeat(1200)}\n`);

        expect(problems.join(' ')).toMatch(new RegExp(String(RELEASE_NOTES_LIMITS.fileChars)));
    });

    it('passes notes that are actually short', () => {
        // POSITIVE CONTROL for every test above: a checker that flagged
        // everything would satisfy them all and mean nothing.
        const ok = [
            '## What’s new',
            '',
            '- **Agents stop losing their work on restart.** Each one leaves a note for its next run.',
            '- **Deleting an agent stops its sidecars too.**',
            '',
            '## Migration',
            '',
            '- No action is required.',
        ].join('\n');

        expect(checkReleaseNotes(ok)).toEqual([]);
    });
});

describe('which files it covers', () => {
    it('covers everything from the version the rule landed in', () => {
        expect(policyAppliesTo(`v${RELEASE_NOTES_POLICY_FROM}.md`)).toBe(true);
        expect(policyAppliesTo('v0.8.0.md')).toBe(true);
        expect(policyAppliesTo('v0.7.0-beta.400.md')).toBe(true);
    });

    it('does not cover notes published before it', () => {
        // Their GitHub release bodies are ALREADY published — editing the files
        // would change nothing anyone sees, so re-litigating them is churn.
        // Derived from the filename, not a hand-kept list, so it cannot rot and
        // a new file can never quietly opt out.
        expect(policyAppliesTo('v0.7.0-beta.293.md')).toBe(false);
        expect(policyAppliesTo('v0.6.0.md')).toBe(false);
    });
});

describe('the corpus', () => {
    const covered = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md') && policyAppliesTo(f));

    it('has every covered release-notes file within the limits', () => {
        const failures = covered.flatMap((f) =>
            checkReleaseNotes(fs.readFileSync(path.join(dir, f), 'utf8')).map((p) => `${f}: ${p}`),
        );

        expect(failures).toEqual([]);
    });
});
