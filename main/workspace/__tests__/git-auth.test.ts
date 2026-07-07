import { describe, expect, it } from 'vitest';
import {
    githubAuthConfig,
    githubCloneAuth,
    githubSshToHttps,
    redactSecrets,
} from '../git-auth';

const TOKEN = 'ghu_exampletoken1234567890';
const B64 = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');

describe('githubSshToHttps', () => {
    it('rewrites scp-style github SSH URLs to HTTPS (keeping .git)', () => {
        expect(githubSshToHttps('git@github.com:owner/repo.git')).toBe(
            'https://github.com/owner/repo.git',
        );
        expect(githubSshToHttps('git@github.com:Org-Name/repo')).toBe(
            'https://github.com/Org-Name/repo',
        );
    });

    it('rewrites ssh:// github URLs to HTTPS', () => {
        expect(githubSshToHttps('ssh://git@github.com/owner/repo.git')).toBe(
            'https://github.com/owner/repo.git',
        );
    });

    it('leaves an already-HTTPS github URL unchanged', () => {
        expect(githubSshToHttps('https://github.com/owner/repo.git')).toBe(
            'https://github.com/owner/repo.git',
        );
    });

    it('leaves non-github hosts and local paths unchanged', () => {
        expect(githubSshToHttps('git@gitlab.com:owner/repo.git')).toBe(
            'git@gitlab.com:owner/repo.git',
        );
        expect(githubSshToHttps('ssh://git@example.com/owner/repo')).toBe(
            'ssh://git@example.com/owner/repo',
        );
        expect(githubSshToHttps('/abs/local/path')).toBe('/abs/local/path');
        expect(githubSshToHttps('C:\\projects\\foo')).toBe('C:\\projects\\foo');
        expect(githubSshToHttps('file:///tmp/x')).toBe('file:///tmp/x');
    });

    it('trims surrounding whitespace', () => {
        expect(githubSshToHttps('  git@github.com:owner/repo.git \n')).toBe(
            'https://github.com/owner/repo.git',
        );
    });
});

describe('githubAuthConfig', () => {
    it('builds insteadOf rewrites for both SSH forms + a token extraheader', () => {
        expect(githubAuthConfig(TOKEN)).toEqual([
            'url.https://github.com/.insteadOf=git@github.com:',
            'url.https://github.com/.insteadOf=ssh://git@github.com/',
            `http.https://github.com/.extraheader=AUTHORIZATION: basic ${B64}`,
        ]);
    });

    it('encodes the token as x-access-token basic auth (not raw)', () => {
        const header = githubAuthConfig(TOKEN).find((c) =>
            c.includes('.extraheader='),
        )!;
        // The raw token must never appear verbatim in the config.
        expect(header).not.toContain(TOKEN);
        const b64 = header.split('basic ')[1];
        expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(
            `x-access-token:${TOKEN}`,
        );
    });
});

describe('githubCloneAuth', () => {
    it('no token → passthrough URL, no config, no secrets (ambient auth preserved)', () => {
        for (const noTok of [null, undefined, '']) {
            expect(githubCloneAuth('git@github.com:o/r.git', noTok)).toEqual({
                url: 'git@github.com:o/r.git',
                config: [],
                secrets: [],
            });
        }
    });

    it('no token → still trims but leaves a local path untouched', () => {
        expect(githubCloneAuth('  /local/env.agi  ', null)).toEqual({
            url: '/local/env.agi',
            config: [],
            secrets: [],
        });
    });

    it('with token → rewrites github SSH → HTTPS and attaches auth config', () => {
        const auth = githubCloneAuth('git@github.com:o/r.git', TOKEN);
        expect(auth.url).toBe('https://github.com/o/r.git');
        expect(auth.config).toEqual(githubAuthConfig(TOKEN));
        expect(auth.secrets).toEqual([TOKEN, B64]);
    });

    it('with token → an HTTPS github URL is authed as-is', () => {
        const auth = githubCloneAuth('https://github.com/o/r.git', TOKEN);
        expect(auth.url).toBe('https://github.com/o/r.git');
        expect(auth.config).toEqual(githubAuthConfig(TOKEN));
    });
});

describe('redactSecrets', () => {
    it('replaces every occurrence of each secret with ***', () => {
        const msg = `fatal: clone of ${TOKEN} failed; header basic ${B64}`;
        const out = redactSecrets(msg, [TOKEN, B64]);
        expect(out).not.toContain(TOKEN);
        expect(out).not.toContain(B64);
        expect(out).toBe('fatal: clone of *** failed; header basic ***');
    });

    it('is a no-op when there are no secrets (the no-token path)', () => {
        expect(redactSecrets('plain error', [])).toBe('plain error');
    });

    it('ignores empty-string secrets without corrupting the message', () => {
        expect(redactSecrets('a-b-c', [''])).toBe('a-b-c');
    });
});
