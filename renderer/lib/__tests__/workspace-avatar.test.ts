import { describe, expect, it } from 'vitest';
import { workspaceInitials } from '../workspace-avatar';

/**
 * A workspace's default avatar is its INITIALS, not a cube.
 *
 * Every `.agi` workspace rendered the same generic box glyph, so a rail of six
 * workspaces was six identical cubes — an icon that tells you nothing is worse
 * than no icon, because it occupies the space where the identifying mark should
 * be. Initials are derived from the name the user chose, so they differ by
 * construction.
 *
 * A user-set icon (in Genie, and in time from Tynn) overrides this; these are
 * only the default.
 */
describe('workspaceInitials', () => {
    it('takes the first letter of the first two words', () => {
        expect(workspaceInitials('The Ripple Effect')).toBe('TR');
        expect(workspaceInitials('Biz Commander')).toBe('BC');
    });

    it('splits a dotted name, so tynn.ai is not just T', () => {
        // `Tynn.ai` and `Tynn.dev` would otherwise be identical marks, which is
        // exactly the collision the cube had.
        expect(workspaceInitials('Tynn.ai')).toBe('TA');
    });

    it('splits on hyphens and underscores too', () => {
        expect(workspaceInitials('guard-card')).toBe('GC');
        expect(workspaceInitials('my_level_up')).toBe('ML');
    });

    it('uses two letters of a single word rather than one', () => {
        // One letter collides far too easily across a rail of workspaces.
        expect(workspaceInitials('Prism')).toBe('PR');
    });

    it('is always upper case', () => {
        expect(workspaceInitials('impactopia')).toBe('IM');
    });

    it('ignores punctuation and extra spacing', () => {
        expect(workspaceInitials('  Wish’s   Workshop  ')).toBe('WW');
    });

    it('handles a name that is one character', () => {
        expect(workspaceInitials('X')).toBe('X');
    });

    it('falls back to a mark rather than empty for a nameless workspace', () => {
        // An empty avatar reads as a broken row; something is better than a gap.
        expect(workspaceInitials('')).toBe('?');
        expect(workspaceInitials('   ')).toBe('?');
        expect(workspaceInitials('···')).toBe('?');
    });

    it('never returns more than two characters', () => {
        // It is drawn in an 18px square; a third letter does not fit and would
        // shrink the other two into illegibility.
        for (const name of ['a b c d', 'Renaissance Analytics Group', 'x-y-z']) {
            expect(workspaceInitials(name).length, name).toBeLessThanOrEqual(2);
        }
    });

    it('handles a non-latin name without producing an empty mark', () => {
        expect(workspaceInitials('日本 プロジェクト').length).toBeGreaterThan(0);
    });
});
