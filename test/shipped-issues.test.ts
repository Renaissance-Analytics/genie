import { describe, expect, it } from 'vitest';
import { previousReleaseTag, shippedIssues, SHIPPED_MARKER, shippedComment } from '../src/core/shipped-issues.js';

/**
 * CLOSE ON SHIP (the owner's choice, 2026-10-21; moic's `issues:close-shipped`). For Genie a merge is not a release: an
 * issue a merged fix names is not in anybody's hands until the release that carries it. At release, every issue a shipped
 * commit says it FIXES or CLOSES is told "Shipped in vX" and closed if still open.
 *
 * ONLY those keywords: a commit that mentions `#757` in passing ("not #757", "the same trap as #812", a squash title's
 * PR number) is not a claim that #757 is fixed, and closing on any mention would close the wrong issues.
 */
const REPO = 'Renaissance-Analytics/genie';

describe('which issues a release ships', () => {
    it('reads GitHub’s closing keywords, in any case and tense, for this repository', () => {
        expect(shippedIssues([
            'The meter follows a compaction\n\nFixes #1086',
            'fix #12: a typo',
            'Closes #7 and resolves #8',
            'closed #9',
            `Fixed ${REPO}#10`,
        ], REPO)).toEqual([7, 8, 9, 10, 12, 1086]);
    });

    it('a passing mention, a PR number in a squash title, another repository and a hedge are NOT shipped', () => {
        expect(shippedIssues([
            'IssueWatch dials the socket server Tynn names (#1085)',
            'Same trap as #812; refs #900',
            'Part of #1081',
            'Fixes Renaissance-Analytics/tynn.ai#309',
            'does not fix #44',
            'Fixes #5', // POSITIVE CONTROL: the parser does read this log
        ], REPO)).toEqual([5]);
    });

    it('counts an issue once however many commits name it', () => {
        expect(shippedIssues(['fixes #3', 'Fixes #3 again', 'closes #3'], REPO)).toEqual([3]);
    });
});

describe('the release it follows', () => {
    it('the newest v* tag before this one, prereleases included; null for the first', () => {
        const tags = ['v2.0.0-beta.34', 'v2.0.0-beta.33', 'v1.9.0', 'not-a-release'];
        expect(previousReleaseTag(tags, 'v2.0.0-beta.35')).toBe('v2.0.0-beta.34');
        expect(previousReleaseTag(tags, 'v2.0.0-beta.34')).toBe('v2.0.0-beta.33');
        expect(previousReleaseTag(['v2.0.0-beta.35'], 'v2.0.0-beta.35')).toBeNull();
    });
});

describe('what the issue is told', () => {
    it('names the release, links it, and carries a marker so a re-run comments once', () => {
        const body = shippedComment('v2.0.0-beta.35', REPO);
        expect(body).toContain('v2.0.0-beta.35');
        expect(body).toContain(`https://github.com/${REPO}/releases/tag/v2.0.0-beta.35`);
        expect(body).toContain(SHIPPED_MARKER('v2.0.0-beta.35'));
    });
});
