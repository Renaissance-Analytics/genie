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
    it('passes a genuine feature-commit subject through unchanged', () => {
        expect(describeCommit('Add per-bucket IssueWatch remediation policy')).toBe(
            'Add per-bucket IssueWatch remediation policy',
        );
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
