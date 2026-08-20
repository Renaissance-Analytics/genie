import { describe, expect, it } from 'vitest';
import {
    buildGithubReview,
    parseGithubSource,
    verifyHumanConfirmation,
} from '../github-install';
import { validateAppManifest, type AppManifest } from '../manifest';

/**
 * Installing a Genie App from GitHub (Tynn #250, P4).
 *
 * This is the moment untrusted third-party code arrives on someone's machine, and
 * the owner's requirement is a two-step confirmation that **a human must do**. So
 * the design is: a REVIEW the person reads, then a deliberate act they have to
 * perform, then the OS consent modal. Three things an agent cannot click through.
 *
 * What the review shows is the whole point. A permission list alone is not enough:
 * a `services[].command` is code that will run on this machine, and burying it
 * under "advanced" would mean the most dangerous line in the manifest is the one
 * nobody reads. Everything that executes, everything that escalates, and exactly
 * WHICH commit it came from, in one place.
 */

const manifest = (over: Record<string, unknown> = {}): AppManifest => {
    const result = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: ['hosting'] },
        ...over,
    });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.value;
};

describe('where it came from', () => {
    it('reads owner and repo out of an https URL', () => {
        const source = parseGithubSource('https://github.com/acme/trader-app.git');
        expect(source).toMatchObject({ owner: 'acme', repo: 'trader-app' });
    });

    it('accepts the same repo without the .git suffix, or with a trailing slash', () => {
        for (const url of [
            'https://github.com/acme/trader-app',
            'https://github.com/acme/trader-app/',
        ]) {
            expect(parseGithubSource(url), url).toMatchObject({ owner: 'acme', repo: 'trader-app' });
        }
    });

    it('accepts the ssh form, since private repos are normal', () => {
        expect(parseGithubSource('git@github.com:acme/trader-app.git')).toMatchObject({
            owner: 'acme',
            repo: 'trader-app',
        });
    });

    it('refuses a host that is not GitHub', () => {
        // Not snobbery about hosts — the review SAYS "GitHub", and a review that
        // names the wrong provenance is worse than no review.
        expect(parseGithubSource('https://gitlab.com/acme/trader-app')).toBeNull();
        expect(parseGithubSource('https://github.com.evil.test/acme/app')).toBeNull();
    });

    it('refuses anything that is not a repo URL at all', () => {
        for (const bad of ['', 'acme/trader-app', 'not a url', 'file:///etc/passwd']) {
            expect(parseGithubSource(bad), bad).toBeNull();
        }
    });
});

describe('the review a person actually reads', () => {
    const review = (over: Record<string, unknown> = {}) =>
        buildGithubReview({
            source: parseGithubSource('https://github.com/acme/trader-app')!,
            commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            ref: 'main',
            manifest: manifest(over),
        });

    it('names the exact COMMIT, not just the branch', () => {
        // "main" is whatever is there later. What is being installed is a commit,
        // and the review should say which one.
        expect(review().commit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
        expect(review().shortCommit).toBe('a1b2c3d');
    });

    it('says where it came from in a form a person can check', () => {
        expect(review().origin).toBe('github.com/acme/trader-app');
    });

    it('lists every COMMAND that will run on this machine', () => {
        // The most dangerous line in a manifest is an argv, and it is the one a
        // permission list does not mention at all.
        const r = review({
            services: [
                { name: 'api', repo: 'backend', command: ['uvicorn', 'app:api'], port: 8000 },
                { name: 'worker', command: ['node', 'worker.js'] },
            ],
        });

        expect(r.commands).toEqual(['uvicorn app:api', 'node worker.js']);
    });

    it('shows no commands for an app that runs none', () => {
        expect(review().commands).toEqual([]);
    });

    it('separates the permissions that hand over the machine', () => {
        const r = review({
            permissions: { scope: 'self', capabilities: ['hosting', 'terminals', 'secrets'] },
        });

        expect(r.highRisk.map((c) => c.key)).toEqual(['terminals', 'secrets']);
        expect(r.standard.map((c) => c.key)).toEqual(['hosting']);
    });

    it('calls out a workstation-wide reach as its own line', () => {
        const r = review({
            permissions: { scope: 'workstation', capabilities: ['hosting'] },
        });
        expect(r.escalations.join(' ')).toMatch(/every workspace/i);
    });

    it('calls out being reachable from the real browser', () => {
        const r = review({
            frontend: {
                repo: 'web',
                serve: { mode: 'static', root: 'dist' },
                browserExposed: true,
            },
        });
        expect(r.escalations.join(' ')).toMatch(/browser/i);
    });

    it('has nothing to escalate for a modest app', () => {
        expect(review().escalations).toEqual([]);
    });
});

describe('the confirmation a human has to perform', () => {
    it('is the app’s own slug, so it cannot be typed without reading', () => {
        expect(verifyHumanConfirmation('trader', manifest())).toBe(true);
    });

    it('refuses a near miss', () => {
        for (const typed of ['trade', 'traderr', 'Example Trader', 'yes', 'y']) {
            expect(verifyHumanConfirmation(typed, manifest()), typed).toBe(false);
        }
    });

    it('refuses an empty confirmation, whatever it is made of', () => {
        for (const typed of ['', '   ', '\n', '\t']) {
            expect(verifyHumanConfirmation(typed, manifest()), JSON.stringify(typed)).toBe(false);
        }
    });

    it('forgives surrounding whitespace and casing, but nothing else', () => {
        // The point is a deliberate act, not a spelling test. Being pedantic about
        // case teaches people to paste, which is the opposite of reading.
        expect(verifyHumanConfirmation('  TRADER  ', manifest())).toBe(true);
    });

    it('refuses when there is nothing to confirm against', () => {
        expect(verifyHumanConfirmation('trader', null)).toBe(false);
    });
});
