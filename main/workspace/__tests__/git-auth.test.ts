import { describe, expect, it } from 'vitest';
import {
    explainCloneFailure,
    ghIsGitCredentialHelper,
    githubAuthConfig,
    githubCloneAuth,
    githubInsteadOfRewrites,
    githubSshToHttps,
    isHostGithubGhConfigured,
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

describe('githubInsteadOfRewrites', () => {
    it('is the two SSH→HTTPS insteadOf entries, with NO token extraheader', () => {
        expect(githubInsteadOfRewrites()).toEqual([
            'url.https://github.com/.insteadOf=git@github.com:',
            'url.https://github.com/.insteadOf=ssh://git@github.com/',
        ]);
    });

    it('is the prefix of githubAuthConfig (the token path adds only the extraheader)', () => {
        const full = githubAuthConfig(TOKEN);
        expect(full.slice(0, 2)).toEqual(githubInsteadOfRewrites());
        expect(full).toHaveLength(3);
    });
});

// Owner gh-auth (genie-cloud workstation, issue #2): when the host has run
// `gh auth setup-git`, gh is git's credential helper for ALL of github.com, so
// it covers EVERY account the owner can access — cross-owner private submodules
// included. In that mode the recursive clone must rely on gh and must NOT inject
// the envelope-owner App-token extraheader (a single-owner token that 404s a
// cross-owner submodule, AND an explicit Authorization header shadows the helper).
describe('githubCloneAuth — ghConfigured (owner gh-auth)', () => {
    it('gh-configured + token → keeps insteadOf rewrites, DROPS the extraheader, leaks no secret', () => {
        const auth = githubCloneAuth('git@github.com:o/r.git', TOKEN, { ghConfigured: true });
        // SSH → HTTPS so gh's HTTPS credential helper applies to the top-level clone.
        expect(auth.url).toBe('https://github.com/o/r.git');
        // insteadOf rewrites remain (so SSH-pinned submodules fetch over HTTPS
        // where gh's helper applies) but the token extraheader is gone.
        expect(auth.config).toEqual(githubInsteadOfRewrites());
        expect(auth.config.some((c) => c.includes('extraheader'))).toBe(false);
        expect(auth.config.join('\n')).not.toContain(B64);
        // The token is neither used nor surfaced as a scrub secret.
        expect(auth.secrets).toEqual([]);
    });

    it('gh-configured + NO token → same insteadOf-only config (gh authenticates)', () => {
        for (const noTok of [null, undefined, '']) {
            const auth = githubCloneAuth('git@github.com:o/r.git', noTok, { ghConfigured: true });
            expect(auth.url).toBe('https://github.com/o/r.git');
            expect(auth.config).toEqual(githubInsteadOfRewrites());
            expect(auth.secrets).toEqual([]);
        }
    });

    it('gh-configured still rewrites BOTH SSH submodule forms (the cross-owner fix)', () => {
        const auth = githubCloneAuth('https://github.com/o/r.git', TOKEN, { ghConfigured: true });
        expect(auth.config).toContain('url.https://github.com/.insteadOf=git@github.com:');
        expect(auth.config).toContain('url.https://github.com/.insteadOf=ssh://git@github.com/');
    });

    it('ghConfigured:false is EXACTLY today — the App-token extraheader fallback', () => {
        const gated = githubCloneAuth('git@github.com:o/r.git', TOKEN, { ghConfigured: false });
        const today = githubCloneAuth('git@github.com:o/r.git', TOKEN);
        expect(gated).toEqual(today);
        expect(gated.config).toEqual(githubAuthConfig(TOKEN));
        expect(gated.secrets).toEqual([TOKEN, B64]);
    });

    it('no opts is EXACTLY today (both token and no-token paths unchanged)', () => {
        expect(githubCloneAuth('git@github.com:o/r.git', TOKEN)).toEqual(
            githubCloneAuth('git@github.com:o/r.git', TOKEN, { ghConfigured: false }),
        );
        expect(githubCloneAuth('git@github.com:o/r.git', null)).toEqual({
            url: 'git@github.com:o/r.git',
            config: [],
            secrets: [],
        });
    });
});

describe('ghIsGitCredentialHelper', () => {
    it('detects gh as the credential helper across path / bang / .exe forms', () => {
        for (const v of [
            '!/usr/bin/gh auth git-credential',
            '!gh auth git-credential',
            '/opt/homebrew/bin/gh auth git-credential',
            // The real Windows form `gh auth setup-git` writes — a QUOTED path, so
            // the char after `gh.exe` is a `'`, not whitespace (regression guard).
            "!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential",
            'C:\\Program Files\\GitHub CLI\\gh.exe auth git-credential',
            'gh',
        ]) {
            expect(ghIsGitCredentialHelper([v])).toBe(true);
        }
    });

    it('ignores the empty clearing line setup-git writes, but sees the gh line after it', () => {
        expect(ghIsGitCredentialHelper(['', '!gh auth git-credential'])).toBe(true);
    });

    it('is false for non-gh helpers and gh-lookalikes (no false positives)', () => {
        for (const v of ['osxkeychain', 'manager', 'store', 'cache', 'ghq', 'my-gh-tool', '']) {
            expect(ghIsGitCredentialHelper([v])).toBe(false);
        }
        expect(ghIsGitCredentialHelper([])).toBe(false);
    });
});

describe('isHostGithubGhConfigured', () => {
    it('true when the gh helper is set on the github.com host key', () => {
        const run = (args: string[]): string =>
            args.includes('credential.https://github.com.helper')
                ? '\n!/usr/bin/gh auth git-credential\n'
                : '';
        expect(isHostGithubGhConfigured(run)).toBe(true);
    });

    it('true when the gh helper is set on the global credential.helper key', () => {
        const run = (args: string[]): string =>
            args.includes('credential.helper') ? '!gh auth git-credential\n' : '';
        expect(isHostGithubGhConfigured(run)).toBe(true);
    });

    it('false when no gh helper is configured', () => {
        expect(isHostGithubGhConfigured(() => 'osxkeychain\n')).toBe(false);
    });

    it('treats a missing key (git config exit 1 → throw) as not-configured', () => {
        // `git config --get-all <unset>` exits non-zero → execFileSync throws.
        expect(
            isHostGithubGhConfigured(() => {
                throw new Error('exit 1');
            }),
        ).toBe(false);
    });

    it('defaults to a real git probe and returns a boolean without throwing', () => {
        expect(typeof isHostGithubGhConfigured()).toBe('boolean');
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

/**
 * genie#378 — a recursive `.agi` clone must not span two credential systems.
 *
 * Reported from Omarchy: the PARENT cloned fine over HTTPS (gh's credential
 * helper answered), then every submodule pinned to `git@github.com:` failed with
 * `Host key verification failed`, because Genie has never verified — and cannot
 * prompt for — the SSH half. The one submodule with an HTTPS URL in the same
 * `.gitmodules` succeeded: same clone, same instant, only the scheme differed.
 */
describe('githubCloneAuth — the submodule pass follows the PARENT auth path (genie#378)', () => {
    it('no token + an HTTPS github parent → SSH submodules are fetched over HTTPS too', () => {
        const auth = githubCloneAuth('https://github.com/org/thing.agi', null);
        expect(auth.url).toBe('https://github.com/org/thing.agi');
        // The rewrites carry NO credential — they only keep the whole recursive
        // tree on the scheme the parent already authenticated on.
        expect(auth.config).toEqual(githubInsteadOfRewrites());
        expect(auth.secrets).toEqual([]);
    });

    it('no token + an SSH parent → left ALONE (the user’s ambient SSH auth still works)', () => {
        // Rewriting here would take a working SSH clone off SSH and onto HTTPS,
        // where a user with no token has no credential at all.
        expect(githubCloneAuth('git@github.com:o/r.git', null)).toEqual({
            url: 'git@github.com:o/r.git',
            config: [],
            secrets: [],
        });
        expect(githubCloneAuth('ssh://git@github.com/o/r', null)).toEqual({
            url: 'ssh://git@github.com/o/r',
            config: [],
            secrets: [],
        });
    });

    it('no token + a non-github HTTPS parent → no rewrites (our rewrite is github-only)', () => {
        expect(githubCloneAuth('https://gitlab.com/o/r.git', null).config).toEqual([]);
        expect(githubCloneAuth('/local/env.agi', null).config).toEqual([]);
        expect(githubCloneAuth('file:///tmp/x', null).config).toEqual([]);
    });

    it('accepts an HTTPS github URL carrying userinfo', () => {
        expect(githubCloneAuth('https://user@github.com/o/r.git', null).config).toEqual(
            githubInsteadOfRewrites(),
        );
    });
});

/** The wall of text the Omarchy clone actually produced, repeated per submodule. */
const HOST_KEY_WALL = [
    "Cloning into '/home/u/Work/thing.agi/repos/alpha'...",
    'ssh_askpass: exec(/usr/lib/ssh/ssh-askpass): No such file or directory',
    'Host key verification failed.',
    'fatal: Could not read from remote repository.',
    "fatal: clone of 'git@github.com:org/alpha.git' into submodule path '/home/u/Work/thing.agi/repos/alpha' failed",
    "Failed to clone 'repos/alpha'. Retry scheduled",
    'ssh_askpass: exec(/usr/lib/ssh/ssh-askpass): No such file or directory',
    'Host key verification failed.',
    'fatal: Could not read from remote repository.',
    "fatal: clone of 'git@github.com:org/beta.git' into submodule path '/home/u/Work/thing.agi/repos/beta' failed",
    "Failed to clone 'repos/beta'. Retry scheduled",
].join('\n');

describe('explainCloneFailure — one actionable line, not one wall per submodule (genie#378)', () => {
    it('translates the host-key wall into the single command that fixes it', () => {
        const msg = explainCloneFailure(HOST_KEY_WALL);
        expect(msg).not.toBeNull();
        expect(msg).toContain('ssh -T git@github.com');
        expect(msg).toMatch(/host key/i);
        // The submodules that failed are NAMED once, not repeated per line.
        expect(msg).toContain('repos/alpha');
        expect(msg).toContain('repos/beta');
        expect(msg!.split('\n').length).toBeLessThanOrEqual(2);
        // Positive control for the "one line" assertion: the input really was a
        // multi-line wall, so the collapse is doing work.
        expect(HOST_KEY_WALL.split('\n').length).toBeGreaterThan(5);
    });

    it('names an askpass failure as the same host-key problem, not a missing dependency', () => {
        const msg = explainCloneFailure(
            'ssh_askpass: exec(/usr/lib/ssh/ssh-askpass): No such file or directory\n' +
                'fatal: Could not read from remote repository.',
        );
        expect(msg).toMatch(/host key/i);
        expect(msg).not.toMatch(/ssh_askpass/);
    });

    it('distinguishes a rejected key from an untrusted host key', () => {
        const msg = explainCloneFailure(
            'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
        );
        expect(msg).toMatch(/ssh key/i);
        expect(msg).not.toContain('ssh -T git@github.com');
    });

    it('names the HTTPS credential problem when git could not ask for one', () => {
        expect(
            explainCloneFailure(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            ),
        ).toMatch(/connect github/i);
        expect(
            explainCloneFailure('remote: Invalid username or password.\nfatal: Authentication failed'),
        ).toMatch(/connect github/i);
    });

    it('returns null for anything it does not recognise — the raw error still wins', () => {
        expect(explainCloneFailure('fatal: destination path already exists')).toBeNull();
        expect(explainCloneFailure('')).toBeNull();
    });
});
