import { describe, expect, it } from 'vitest';
import { defaultRemoteChoice, githubOwnerOptions, parseRemoteChoice, remoteChoiceProblem, remotePlanText } from '../src/core/agi-remote.js';
import { cloneAuthFor, pushAuthFor, signedOutGithubView, type GithubInstallation, type GithubView } from '../src/core/github.js';

/**
 * WHERE A NEW WORKSPACE'S `<slug>.agi` GOES — the pure half (Add workspace parity items 10 + 11). Genie 1's owner picker
 * (GitHubConnect.tsx OwnerSelect: the person + every org the App is installed on, a not-installed prompt for the chosen
 * one), its plan line ("Backed up to GitHub as owner/slug.agi (private)" or local-only with the reason), and its wizard's
 * None / GitHub / Paste URL. The owner, 2026-10-21: GitHub is optional — "users should be able to work off-grid" — so
 * None is the default whenever there is no GitHub sign-in.
 */

const install = (over: Partial<GithubInstallation> & { account: string }): GithubInstallation => ({
    id: 1, isOrg: false, selection: 'all', repoCount: null, repos: null, permissions: { contents: 'write', metadata: 'read', administration: 'write' }, settingsUrl: 'https://github.com/settings/installations/1', ...over,
});

const signedIn = (installations: GithubInstallation[] | null, login = 'ada'): GithubView => ({
    ...signedOutGithubView(null), status: 'signed-in', user: { login, name: 'Ada' }, installations,
});

describe('the default choice', () => {
    it('no GitHub sign-in (or no view at all): None — off-grid is the default, not a fallback', () => {
        expect(defaultRemoteChoice(null)).toEqual({ kind: 'none' });
        expect(defaultRemoteChoice(undefined)).toEqual({ kind: 'none' });
        expect(defaultRemoteChoice(signedOutGithubView(null))).toEqual({ kind: 'none' });
        expect(defaultRemoteChoice({ ...signedOutGithubView(null), status: 'expired' })).toEqual({ kind: 'none' });
    });

    it('signed in: GitHub, under the person, PRIVATE (Genie 1’s default)', () => {
        expect(defaultRemoteChoice(signedIn([install({ account: 'ada' })]))).toEqual({ kind: 'github', owner: 'ada', private: true });
    });
});

describe('the owner picker', () => {
    it('lists the person first, then each org the App is installed on — COUNTED', () => {
        const opts = githubOwnerOptions(signedIn([
            install({ id: 1, account: 'ada' }),
            install({ id: 2, account: 'acme-org', isOrg: true }),
            install({ id: 3, account: 'civic', isOrg: true }),
        ]));
        expect(opts).toEqual([
            { login: 'ada', personal: true, installed: true },
            { login: 'acme-org', personal: false, installed: true },
            { login: 'civic', personal: false, installed: true },
        ]);
    });

    it('the person without an installation of their own is still listed — marked not installed (Genie 1’s prompt)', () => {
        const opts = githubOwnerOptions(signedIn([install({ id: 2, account: 'acme-org', isOrg: true })]));
        expect(opts[0]).toEqual({ login: 'ada', personal: true, installed: false });
        expect(opts).toHaveLength(2);
    });

    it('installations not read yet: the person, installed unknown (null) — never a guessed "not installed"', () => {
        expect(githubOwnerOptions(signedIn(null))).toEqual([{ login: 'ada', personal: true, installed: null }]);
    });

    it('an account whose installation lacks Administration (write) says so in one line, with the installation to approve it on — and a granted one does not (control)', () => {
        const opts = githubOwnerOptions(signedIn([
            install({ id: 1, account: 'ada' }),
            install({ id: 2, account: 'acme-org', isOrg: true, permissions: { contents: 'write', metadata: 'read' }, settingsUrl: 'https://github.com/organizations/acme-org/settings/installations/2' }),
        ]));
        const org = opts.find((o) => o.login === 'acme-org')!;
        expect(org).toMatchObject({ installed: true, approve: { installationId: 2 } });
        expect(org.approve!.reason).toContain('Administration (Read and write)');
        expect(org.approve!.reason).not.toContain('\n');
        expect('approve' in opts.find((o) => o.login === 'ada')!).toBe(false);
    });

    it('signed out: nobody to pick', () => {
        expect(githubOwnerOptions(signedOutGithubView(null))).toEqual([]);
        expect(githubOwnerOptions(null)).toEqual([]);
    });
});

describe('a choice from the window is parsed, never trusted', () => {
    it('the three kinds round-trip', () => {
        expect(parseRemoteChoice({ kind: 'none' })).toEqual({ kind: 'none' });
        expect(parseRemoteChoice({ kind: 'github', owner: 'acme-org', private: false })).toEqual({ kind: 'github', owner: 'acme-org', private: false });
        expect(parseRemoteChoice({ kind: 'paste', url: '  git@github.com:acme/acme.agi.git  ' })).toEqual({ kind: 'paste', url: 'git@github.com:acme/acme.agi.git' });
    });

    it('anything else is refused (null): unknown kinds, a missing owner, a non-boolean private, an owner GitHub would not accept', () => {
        for (const raw of [null, 'none', 42, {}, { kind: 'ftp' }, { kind: 'github', private: true }, { kind: 'github', owner: 'a', private: 'yes' }, { kind: 'github', owner: '../evil', private: true }, { kind: 'paste' }, { kind: 'paste', url: 7 }]) {
            expect(parseRemoteChoice(raw)).toBeNull();
        }
        // Positive control: the same shape with valid values parses.
        expect(parseRemoteChoice({ kind: 'github', owner: 'a', private: true })).not.toBeNull();
    });
});

describe('why a choice cannot be used yet', () => {
    it('None and a complete GitHub choice are fine', () => {
        expect(remoteChoiceProblem({ kind: 'none' })).toBeNull();
        expect(remoteChoiceProblem({ kind: 'github', owner: 'ada', private: true })).toBeNull();
        expect(remoteChoiceProblem({ kind: 'paste', url: 'https://github.com/acme/acme.agi.git' })).toBeNull();
    });

    it('an empty paste, a URL with spaces, or one git would read as an option is refused in words', () => {
        expect(remoteChoiceProblem({ kind: 'paste', url: '' })).toMatch(/paste/i);
        expect(remoteChoiceProblem({ kind: 'paste', url: 'https://x y' })).toMatch(/space/i);
        expect(remoteChoiceProblem({ kind: 'paste', url: '--upload-pack=evil' })).not.toBeNull();
        expect(remoteChoiceProblem({ kind: 'github', owner: '', private: true })).toMatch(/owner|account/i);
    });
});

describe('the plan line (Genie 1’s words)', () => {
    it('says where the repository goes, or that it stays on this machine', () => {
        expect(remotePlanText({ kind: 'github', owner: 'acme-org', private: true }, 'acme.agi')).toBe('Backed up to GitHub as acme-org/acme.agi (private), pushed once it exists.');
        expect(remotePlanText({ kind: 'github', owner: 'ada', private: false }, 'acme.agi')).toBe('Backed up to GitHub as ada/acme.agi (public), pushed once it exists.');
        expect(remotePlanText({ kind: 'paste', url: 'git@example.com:me/acme.agi.git' }, 'acme.agi')).toBe('Pushed to git@example.com:me/acme.agi.git as origin once it is made.');
        expect(remotePlanText({ kind: 'none' }, 'acme.agi')).toBe('Kept on this machine. You can add a remote later.');
    });
});

describe('the push credential: the sign-in only where the App may WRITE', () => {
    const url = 'https://github.com/acme-org/acme.agi.git';
    it('an installation granting Contents WRITE on that account: the header, and its secrets to scrub', () => {
        const auth = pushAuthFor(url, 'ghu_TOKEN', [install({ account: 'acme-org', isOrg: true, permissions: { contents: 'write' } })]);
        expect(auth?.config).toHaveLength(1);
        expect(auth?.config[0]![0]).toBe('http.https://github.com/.extraheader');
        expect(auth?.secrets).toContain('ghu_TOKEN');
    });

    it('Contents READ only: no header — the person’s own credential helper is left to answer (clone still gets one)', () => {
        const readOnly = [install({ account: 'acme-org', isOrg: true, permissions: { contents: 'read' } })];
        expect(pushAuthFor(url, 'ghu_TOKEN', readOnly)).toBeNull();
        // Positive control: the same installation is good enough to CLONE with.
        expect(cloneAuthFor(url, 'ghu_TOKEN', readOnly)).not.toBeNull();
    });

    it('another account, ssh, another host, or signed out: none', () => {
        const ok = [install({ account: 'acme-org', isOrg: true })];
        expect(pushAuthFor('https://github.com/someone-else/x.agi.git', 'ghu_TOKEN', ok)).toBeNull();
        expect(pushAuthFor('git@github.com:acme-org/acme.agi.git', 'ghu_TOKEN', ok)).toBeNull();
        expect(pushAuthFor('https://gitlab.com/acme-org/acme.agi.git', 'ghu_TOKEN', ok)).toBeNull();
        expect(pushAuthFor(url, null, ok)).toBeNull();
        expect(pushAuthFor(url, 'ghu_TOKEN', null)).toBeNull();
    });
});
