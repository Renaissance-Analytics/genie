import { describe, expect, it } from 'vitest';
import { composerConstraintAllows, composerPhpRequirement, pickComposerPhp } from '../composer-php';

/**
 * WHICH PHP A REPO ASKS FOR, READ FROM THE REPO (genie#668, owner decision).
 *
 * "Projects still get to set what version of php it uses. This should be read
 * directly from composer setting in the repo, so not something an agent has to
 * provide when setting up a site."
 *
 * Composer's constraint language is NOT npm's, and the difference picks the wrong
 * runtime: `~8.3` is `>=8.3 <9.0` to Composer but `>=8.3.0 <8.4.0` to npm, and a
 * bare `8.3` is an EXACT version to Composer. So the rules here are Composer's,
 * pinned case by case against its documentation.
 */

describe('composerPhpRequirement — where the repo says it', () => {
    it('prefers config.platform.php — the exact platform Composer resolves against — as that version\'s line', () => {
        expect(
            composerPhpRequirement({ require: { php: '^8.2' }, config: { platform: { php: '8.3.12' } } }),
        ).toEqual({ constraint: '8.3.*', source: 'config.platform.php' });
    });

    it('otherwise reads require.php', () => {
        expect(composerPhpRequirement({ require: { php: '^8.2' } })).toEqual({
            constraint: '^8.2',
            source: 'require.php',
        });
    });

    it('is null when the repo states nothing — the machine default then applies', () => {
        expect(composerPhpRequirement({ require: { 'laravel/framework': '^12.0' } })).toBeNull();
        expect(composerPhpRequirement({})).toBeNull();
        expect(composerPhpRequirement(null)).toBeNull();
        expect(composerPhpRequirement('not json')).toBeNull();
        expect(composerPhpRequirement({ require: { php: 42 } })).toBeNull();
        expect(composerPhpRequirement({ require: { php: '   ' } })).toBeNull();
    });
});

describe('composerConstraintAllows — Composer semantics, not npm', () => {
    const cases: Array<[string, string, boolean]> = [
        // caret: next significant release
        ['^8.2', '8.2.0', true],
        ['^8.2', '8.4.24', true],
        ['^8.2', '8.1.30', false],
        ['^8.2', '9.0.0', false],
        ['^8.3.5', '8.3.4', false],
        ['^8.3.5', '8.3.33', true],
        // tilde: Composer's, where the LAST given part may move
        ['~8.3', '8.4.24', true],
        ['~8.3', '8.2.33', false],
        ['~8.3', '9.0.0', false],
        ['~8.3.0', '8.3.33', true],
        ['~8.3.0', '8.4.0', false],
        // wildcards
        ['8.3.*', '8.3.33', true],
        ['8.3.*', '8.4.0', false],
        ['8.*', '8.2.0', true],
        ['*', '8.4.24', true],
        // comparison operators, AND by comma or space, OR by ||
        ['>=8.2', '8.2.0', true],
        ['>=8.2 <8.4', '8.3.33', true],
        ['>=8.2 <8.4', '8.4.0', false],
        ['>=8.2,<8.4', '8.4.24', false],
        ['>= 8.2, < 8.4', '8.3.1', true],
        ['^8.2 || ^9.0', '8.4.24', true],
        ['^8.1|^8.2', '8.3.0', true],
        ['<8.2', '8.2.0', false],
        ['!=8.3.0', '8.3.0', false],
        ['!=8.3.0', '8.3.1', true],
        // a bare version is EXACT to Composer
        ['8.3', '8.3.0', true],
        ['8.3', '8.3.33', false],
        ['8.3.33', '8.3.33', true],
        // stability flags do not change which PHP satisfies it
        ['^8.2@dev', '8.4.0', true],
        ['>=8.2-dev', '8.2.0', true],
    ];
    for (const [constraint, version, allowed] of cases) {
        it(`${JSON.stringify(constraint)} ${allowed ? 'allows' : 'rejects'} ${version}`, () => {
            expect(composerConstraintAllows(constraint, version)).toBe(allowed);
        });
    }

    it('allows NOTHING for a constraint it cannot read, rather than everything', () => {
        // An unreadable constraint must fail the start loudly; reading it as "any
        // PHP" is exactly the silent wrong runtime this exists to prevent.
        expect(composerConstraintAllows('banana', '8.4.24')).toBe(false);
        expect(composerConstraintAllows('^', '8.4.24')).toBe(false);
        expect(composerConstraintAllows('', '8.4.24')).toBe(false);
    });
});

describe('pickComposerPhp — which managed PHP a site runs on', () => {
    const managed = ['8.4.24', '8.3.33', '8.2.33'];

    it('keeps the machine default when the repo allows it', () => {
        expect(pickComposerPhp('^8.2', managed, '8.3.33')).toBe('8.3.33');
    });

    it('takes the NEWEST allowed version when the default is not allowed', () => {
        expect(pickComposerPhp('>=8.2 <8.4', managed, '8.4.24')).toBe('8.3.33');
        expect(pickComposerPhp('~8.2.0', managed, '8.4.24')).toBe('8.2.33');
    });

    it('is null when nothing managed satisfies the repo', () => {
        expect(pickComposerPhp('^8.5', managed, '8.4.24')).toBeNull();
        expect(pickComposerPhp('banana', managed, '8.4.24')).toBeNull();
    });
});
