import { describe, expect, it } from 'vitest';

// changelog.ts imports `app`/`net` from electron at load; the vitest config
// aliases electron to a stub, so importing the pure parser here is safe.
import '../../../test/electron-mock';
import { describeCommit } from '../changelog';

/**
 * describeCommit turns one commit message into the line the update popover shows.
 * The bug it fixes: release commits tag the VERSION as the subject (with the real
 * note in the body), so using the subject verbatim showed the version repeated.
 */
describe('describeCommit', () => {
    it('no longer passes an ordinary commit subject through (genie#224)', () => {
        // This USED to pass the subject through, and that was the bug: the
        // popover became a view onto the repo's log. Even a well-written subject
        // like this one is written for the repo — it names an internal concept
        // ("per-bucket") and assumes the reader knows what IssueWatch remediation
        // is. A commit that genuinely changes something people notice says so
        // with a `Release-Note:` trailer.
        expect(describeCommit('Add per-bucket IssueWatch remediation policy')).toBe('');
    });

    it('strips a leading version + em-dash prefix from the subject', () => {
        expect(
            describeCommit('v0.7.0-beta.100 — Fix scrambled remote terminals'),
        ).toBe('Fix scrambled remote terminals');
    });

    it('handles en-dash and (whitespace-flanked) hyphen separators too', () => {
        expect(describeCommit('v0.7.0-beta.100 – Fix the thing')).toBe('Fix the thing');
        expect(describeCommit('v0.7.0-beta.100 - Fix the thing')).toBe('Fix the thing');
        // A version with no prerelease, still stripped.
        expect(describeCommit('v1.2.3 — Ship it')).toBe('Ship it');
    });

    it('falls back to the first non-empty BODY line when the subject is a bare version', () => {
        const msg =
            'v0.7.0-beta.100\n\nRemove the bogus shortcut-hint footer\n\nMore detail here.';
        expect(describeCommit(msg)).toBe('Remove the bogus shortcut-hint footer');
    });

    it('strips a version prefix from the body-derived line too', () => {
        const msg = 'v0.7.0-beta.100\n\nv0.7.0-beta.100 — Real description';
        expect(describeCommit(msg)).toBe('Real description');
    });

    it('returns "" for a version-only commit with no meaningful body (caller drops it)', () => {
        expect(describeCommit('v0.7.0-beta.100')).toBe('');
        expect(describeCommit('v0.7.0-beta.100\n\n')).toBe('');
        expect(describeCommit('0.7.0')).toBe('');
        // A body that is itself only a version is not a real change either.
        expect(describeCommit('v0.7.0-beta.100\n\nv0.7.0-beta.101')).toBe('');
    });

    it('does NOT mistake a prerelease hyphen for the version-desc separator', () => {
        // `-beta.100` must stay part of the version, not be split as "v0.7.0 — beta.100".
        expect(describeCommit('v0.7.0-beta.100')).toBe('');
    });
});

// --- notes are OPT-IN, never scraped from the log (genie#224) ---------------
//
// The popover was built from every non-noise commit SUBJECT between two
// versions. Subjects are written for the repo, so the update popup showed the
// owner lines like "Stop classifying a site by its PUBLISHED port — a running
// container read as host-native" and "Site card: drop the curl line and the
// phantom port". That is engineering reasoning rendered as a product surface.
//
// A filter cannot fix it: the difference between an internal subject and a
// user-facing note is intent, not vocabulary, and a blocklist would keep leaking
// whatever it did not anticipate. So nothing appears unless it was WRITTEN to
// appear — an explicit `Release-Note:` trailer, or the release commit's own
// curated headline.

describe('what reaches the update popover', () => {
    it('takes an explicit Release-Note trailer, whatever the subject says', () => {
        expect(
            describeCommit(
                'refactor(dev-server): collapse two host paths into one\n\n' +
                    'Long engineering rationale nobody outside the repo wants.\n\n' +
                    'Release-Note: Sites start faster after a restart',
            ),
        ).toBe('Sites start faster after a restart');
    });

    it('takes the release commit headline, which is already written for people', () => {
        expect(
            describeCommit('v0.7.0-beta.261 — a terminal can no longer wipe your database'),
        ).toBe('a terminal can no longer wipe your database');
    });

    it('IGNORES an ordinary commit subject — the actual bug', () => {
        // These are real subjects from beta.261. None of them should ever have
        // been shown to anyone.
        for (const subject of [
            'Stop classifying a site by its PUBLISHED port — a running container read as host-native',
            'Site card: drop the curl line and the phantom port, and stop telling people to serve their app root',
            'A terminal no longer inherits the app\u2019s datastore config (genie#221)',
        ]) {
            expect(describeCommit(subject), subject).toBe('');
        }
    });

    it('prefers the trailer over a release headline when a commit somehow has both', () => {
        expect(
            describeCommit('v1.2.3 — internal wording\n\nRelease-Note: The wording people see'),
        ).toBe('The wording people see');
    });

    it('ignores an empty or whitespace-only trailer rather than showing a blank line', () => {
        expect(describeCommit('Something internal\n\nRelease-Note:   ')).toBe('');
    });
});
