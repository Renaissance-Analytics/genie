import { describe, expect, it } from 'vitest';
import { appUpdateState, updatableApps } from '../updates';

/**
 * Is there a newer version of an installed GApp? (Tynn #250)
 *
 * A GitHub install pins a commit — deliberately, because "main" is whatever
 * happens to be there later. The cost of pinning is that an app can sit for months
 * on a version with a bug the author fixed the same week, and nothing ever says so.
 *
 * This answers the question and nothing more. It does NOT update anything: a new
 * version can ask for more permissions than the one the user consented to, so an
 * update has to go back through the review and the consent modal like any other
 * install. Anything that quietly pulled a new commit would be an escalation path
 * with a friendly name.
 */

const github = (commit?: string) => ({
    kind: 'github' as const,
    origin: 'github.com/acme/trader',
    ...(commit ? { commit } : {}),
});

describe('what the state of an app is', () => {
    it('is current when the pinned commit is what the repo has', () => {
        expect(appUpdateState(github('a1b2c3d'), 'a1b2c3d')).toBe('current');
    });

    it('offers an update when the repo has moved on', () => {
        expect(appUpdateState(github('a1b2c3d'), 'ffff999')).toBe('update-available');
    });

    it('is not tracked for an app installed from a folder', () => {
        // A local folder has no upstream to compare against, and reporting one as
        // "up to date" would be a claim Genie cannot make.
        expect(appUpdateState({ kind: 'folder', origin: 'C:/src/trader' }, 'ffff999')).toBe(
            'not-tracked',
        );
    });

    it('is not tracked for an app with no recorded source at all', () => {
        expect(appUpdateState(null, 'ffff999')).toBe('not-tracked');
    });

    it('is UNKNOWN when the repo could not be reached', () => {
        // Distinct from current. A network failure that read as "up to date" would
        // be Genie quietly promising something it did not check.
        expect(appUpdateState(github('a1b2c3d'), null)).toBe('unknown');
        expect(appUpdateState(github('a1b2c3d'), '')).toBe('unknown');
    });

    it('is unknown when nothing was pinned to compare with', () => {
        expect(appUpdateState(github(), 'ffff999')).toBe('unknown');
    });

    it('compares full and short forms of the same commit as equal', () => {
        // `git ls-remote` returns the full sha; what was recorded may be either,
        // and a length mismatch must not read as "a new version".
        const full = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
        expect(appUpdateState(github(full), full)).toBe('current');
        expect(appUpdateState(github('a1b2c3d'), full)).toBe('current');
        expect(appUpdateState(github(full), 'a1b2c3d')).toBe('current');
    });

    it('is not fooled by casing', () => {
        expect(appUpdateState(github('A1B2C3D'), 'a1b2c3d')).toBe('current');
    });
});

describe('which apps are worth asking GitHub about', () => {
    const app = (id: string, source: ReturnType<typeof github> | null) => ({ id, source });

    it('picks only the ones with a repo to check', () => {
        const apps = [
            app('a', github('1111111')),
            app('b', null),
            app('c', { kind: 'folder', origin: 'C:/x' } as never),
        ];

        expect(updatableApps(apps).map((a) => a.id)).toEqual(['a']);
    });

    it('asks about each ORIGIN once, however many apps share it', () => {
        // A monorepo can hold several apps. Hitting the same remote once per app
        // is a rate limit waiting to happen.
        const apps = [app('a', github('1111111')), app('b', github('2222222'))];
        expect(new Set(updatableApps(apps).map((a) => a.origin)).size).toBe(1);
        expect(updatableApps(apps)).toHaveLength(2);
    });

    it('returns nothing when nothing is tracked', () => {
        expect(updatableApps([app('b', null)])).toEqual([]);
    });
});
