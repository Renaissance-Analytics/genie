import { describe, expect, it } from 'vitest';
import { buildAuthEnv } from '../build-auth';

/**
 * THE BUILD AUTH DEFAULTS (genie #119) — what makes a PRODUCTION build actually
 * authenticate.
 *
 * A build `exec`s into the workspace sandbox as a uid that does not own the
 * copied repo, so git refuses it ("dubious ownership") and `composer install`
 * dies before it starts. And once git works, an UNAUTHENTICATED composer/npm
 * fetch of github.com dist tarballs is rate-limited into failure. Both are fixed
 * with environment, layered UNDER the site's own env so a pinned value still
 * wins — this module decides exactly what that environment is.
 */

describe('buildAuthEnv', () => {
    it('ALWAYS marks the repo a git safe.directory — the dubious-ownership fix is unconditional', () => {
        // With no token at all we still get the git-safety triplet: a public
        // build that never authenticates still runs git in a container whose uid
        // does not own the mount.
        const { env } = buildAuthEnv(null);
        expect(env.GIT_CONFIG_COUNT).toBe('1');
        expect(env.GIT_CONFIG_KEY_0).toBe('safe.directory');
        expect(env.GIT_CONFIG_VALUE_0).toBe('*');
    });

    it('injects COMPOSER_AUTH + GITHUB_TOKEN when Genie holds a managed token', () => {
        const { env } = buildAuthEnv('ghs_TESTTOKEN');
        // npm git deps read GITHUB_TOKEN; composer reads COMPOSER_AUTH.
        expect(env.GITHUB_TOKEN).toBe('ghs_TESTTOKEN');
        expect(JSON.parse(env.COMPOSER_AUTH)).toEqual({
            'github-oauth': { 'github.com': 'ghs_TESTTOKEN' },
        });
        // Auth is layered ON TOP of the git-safety default, not instead of it.
        expect(env.GIT_CONFIG_VALUE_0).toBe('*');
    });

    it('injects NEITHER auth var when there is no token — a public-only build still works', () => {
        for (const empty of [null, undefined, '', '   ']) {
            const { env } = buildAuthEnv(empty as string | null);
            expect(env.COMPOSER_AUTH).toBeUndefined();
            expect(env.GITHUB_TOKEN).toBeUndefined();
            // …but the git-safety default is still unconditional.
            expect(env.GIT_CONFIG_VALUE_0).toBe('*');
        }
    });

    it('surfaces the token as a SECRET to scrub when present, and nothing when absent', () => {
        // The build log is shown in the UI, so the token must be scrubbable out
        // of any captured output.
        expect(buildAuthEnv('ghs_TESTTOKEN').secrets).toContain('ghs_TESTTOKEN');
        expect(buildAuthEnv(null).secrets).toEqual([]);
    });
});
