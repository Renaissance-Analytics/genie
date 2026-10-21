import { describe, expect, it } from 'vitest';
import {
    GENIE_GITHUB_CLIENT_ID,
    GITHUB_INSTALL_URL,
    cloneAuthFor,
    deviceCodeFrom,
    githubCapabilities,
    githubSignal,
    installationSettingsUrl,
    installationsFrom,
    pollOutcomeFrom,
    redactSecrets,
    v1GithubLogin,
    type GithubInstallation,
} from '../src/core/github.js';

/**
 * GITHUB FOR REAL — the pure half (beta.33 item 25, Tynn #780). The owner (2026-10-20), on Settings → GitHub's two
 * hand-ticked "done" chips: "our Github integration and login needs to be way easier than this and it needs to be
 * functional not some dumb list … I already had github setup with this app with genie 1 so why is it not functional
 * anymore?"
 *
 * Genie 1 (`v1:main/github/*`): device-flow sign-in to the `genie-aos` GitHub App, the user token kept encrypted, the API
 * read for who you are and where the App is installed, features gated by the permissions GitHub GRANTED. This file pins
 * the parts that are data in, data out: GitHub's device-flow answers, its installation list, what each permission
 * enables, the Deck's signal, Genie 1's stored login, and the clone credential.
 */

const inst = (over: Partial<GithubInstallation> = {}): GithubInstallation => ({
    id: 11,
    account: 'ada',
    isOrg: false,
    selection: 'all',
    repoCount: 3,
    repos: null,
    permissions: { metadata: 'read', contents: 'write', issues: 'read' },
    settingsUrl: 'https://github.com/settings/installations/11',
    ...over,
});

describe('the GitHub App Genie signs in to', () => {
    it('is Genie 1’s genie-aos, by its public client id; installing on more repositories is the App’s own page', () => {
        expect(GENIE_GITHUB_CLIENT_ID).toBe('Iv23liPssWsCpaUIxtIT');
        expect(GITHUB_INSTALL_URL).toBe('https://github.com/apps/genie-aos/installations/new');
    });
});

describe('the device flow, as GitHub answers it', () => {
    it('a device code: the code to show, where to type it, and the interval GitHub dictates', () => {
        expect(deviceCodeFrom({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 }))
            .toEqual({ deviceCode: 'dc', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 899, interval: 5 });
        // No interval in the answer: RFC 8628's default of 5 s, never faster.
        expect(deviceCodeFrom({ device_code: 'dc', user_code: 'A-B', verification_uri: 'https://github.com/login/device', expires_in: 900 })?.interval).toBe(5);
        // GitHub refused (an `error` body) or answered nonsense: no code.
        expect(deviceCodeFrom({ error: 'unauthorized_client' })).toBeNull();
        expect(deviceCodeFrom(null)).toBeNull();
    });

    it('each poll answer: a token, keep waiting, slow down (GitHub’s new interval, else +5 s), or a failure in words', () => {
        expect(pollOutcomeFrom({ access_token: 'ghu_x', token_type: 'bearer' })).toEqual({ kind: 'token', token: 'ghu_x' });
        expect(pollOutcomeFrom({ error: 'authorization_pending' })).toEqual({ kind: 'pending' });
        expect(pollOutcomeFrom({ error: 'slow_down', interval: 10 })).toEqual({ kind: 'slow-down', interval: 10 });
        expect(pollOutcomeFrom({ error: 'slow_down' })).toEqual({ kind: 'slow-down', interval: null });
        expect(pollOutcomeFrom({ error: 'expired_token' })).toMatchObject({ kind: 'failed', code: 'expired_token', message: expect.stringMatching(/expired/i) });
        expect(pollOutcomeFrom({ error: 'access_denied' })).toMatchObject({ kind: 'failed', code: 'access_denied', message: expect.stringMatching(/denied|cancelled/i) });
        expect(pollOutcomeFrom({ error: 'incorrect_device_code', error_description: 'The device_code provided is not valid.' })).toEqual({ kind: 'failed', code: 'incorrect_device_code', message: 'The device_code provided is not valid.' });
    });
});

describe('where the App is installed (GET /user/installations)', () => {
    it('each installation: its account, personal or org, all or selected repositories, the permissions GRANTED, and its own settings page', () => {
        const rows = installationsFrom({
            total_count: 2,
            installations: [
                { id: 11, account: { login: 'ada', type: 'User' }, repository_selection: 'all', permissions: { metadata: 'read', contents: 'write', issues: 'read' } },
                { id: 22, account: { login: 'Example-Org', type: 'Organization' }, repository_selection: 'selected', permissions: { metadata: 'read', issues: 'read', bogus: 'sideways' } },
                { id: 33 }, // no account: not something a person can act on
            ],
        });
        expect(rows).toEqual([
            { id: 11, account: 'ada', isOrg: false, selection: 'all', permissions: { metadata: 'read', contents: 'write', issues: 'read' }, settingsUrl: 'https://github.com/settings/installations/11' },
            // An access level GitHub does not define is dropped, not guessed.
            { id: 22, account: 'Example-Org', isOrg: true, selection: 'selected', permissions: { metadata: 'read', issues: 'read' }, settingsUrl: 'https://github.com/organizations/Example-Org/settings/installations/22' },
        ]);
        expect(installationsFrom({ message: 'Bad credentials' })).toEqual([]);
    });

    it('an org’s installation page is under the org; a person’s under their own settings', () => {
        expect(installationSettingsUrl({ id: 5, account: 'ada', isOrg: false })).toBe('https://github.com/settings/installations/5');
        expect(installationSettingsUrl({ id: 6, account: 'Example-Org', isOrg: true })).toBe('https://github.com/organizations/Example-Org/settings/installations/6');
    });
});

describe('what GitHub’s permissions let Genie do', () => {
    it('signed out: cloning private repositories says to sign in; IssueWatch says it comes through Tynn', () => {
        const rows = githubCapabilities({ signedIn: false, installations: null });
        expect(rows.find((r) => r.id === 'clone-private')).toMatchObject({ enabled: false, note: expect.stringMatching(/sign in/i) });
        expect(rows.find((r) => r.id === 'issue-watch')).toMatchObject({ enabled: true, note: expect.stringMatching(/Tynn/) });
    });

    it('cloning private repositories follows Contents: granted on an installation enables it, named by account; not granted says which permission is missing', () => {
        const ok = githubCapabilities({ signedIn: true, installations: [inst(), inst({ id: 22, account: 'Example-Org', isOrg: true, permissions: { metadata: 'read' } })] });
        expect(ok.find((r) => r.id === 'clone-private')).toMatchObject({ enabled: true, note: expect.stringContaining('ada') });
        expect(ok.find((r) => r.id === 'clone-private')!.note).not.toContain('Example-Org');
        const missing = githubCapabilities({ signedIn: true, installations: [inst({ permissions: { metadata: 'read', issues: 'read' } })] });
        expect(missing.find((r) => r.id === 'clone-private')).toMatchObject({ enabled: false, note: expect.stringMatching(/Contents/) });
        const none = githubCapabilities({ signedIn: true, installations: [] });
        expect(none.find((r) => r.id === 'clone-private')).toMatchObject({ enabled: false, note: expect.stringMatching(/not installed/i) });
    });

    it('the Deck’s signal appears only for something real: a sign-in GitHub stopped accepting, no installation, or no Contents anywhere — never merely signed out', () => {
        expect(githubSignal({ status: 'signed-out', installations: null })).toBeNull();
        expect(githubSignal({ status: 'signing-in', installations: null })).toBeNull();
        // Signed in, GitHub not read yet: nothing claimed either way.
        expect(githubSignal({ status: 'signed-in', installations: null })).toBeNull();
        expect(githubSignal({ status: 'signed-in', installations: [inst()] })).toBeNull();
        expect(githubSignal({ status: 'expired', installations: null })).toEqual({ label: 'GitHub permissions are blocking features', route: 'genie://settings/github' });
        expect(githubSignal({ status: 'signed-in', installations: [] })).not.toBeNull();
        expect(githubSignal({ status: 'signed-in', installations: [inst({ permissions: { metadata: 'read' } })] })).not.toBeNull();
    });
});

describe('Genie 1’s stored login (its settings table)', () => {
    it('the encrypted token and the login it was saved for; nothing stored is null', () => {
        expect(v1GithubLogin({ github_token_enc: 'djEw', github_user: 'ada', github_refresh_enc: '' })).toEqual({ tokenEnc: 'djEw', login: 'ada' });
        expect(v1GithubLogin({ github_token_enc: 'djEw' })).toEqual({ tokenEnc: 'djEw', login: null });
        expect(v1GithubLogin({ github_token_enc: '', github_user: 'ada' })).toBeNull();
        expect(v1GithubLogin({})).toBeNull();
        expect(v1GithubLogin(null)).toBeNull();
    });
});

describe('the clone credential', () => {
    const TOKEN = 'ghu_exampletoken0000000000000000000000';
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

    it('an https github.com repo of an account the App is installed on with Contents: the token as an http header, never in the URL', () => {
        const auth = cloneAuthFor('https://github.com/Ada/private-thing.git', TOKEN, [inst()]);
        expect(auth).not.toBeNull();
        expect(auth!.config).toEqual([['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`]]);
        // Both forms the token could leak in are scrubbed from anything git says.
        expect(auth!.secrets).toEqual([TOKEN, basic]);
    });

    it('anything else clones with the person’s own git credentials, untouched: no token, another account, no Contents, not github.com', () => {
        expect(cloneAuthFor('https://github.com/ada/x.git', null, [inst()])).toBeNull();
        // Another account: a header would SHADOW the person's own credential helper, which may well reach it.
        expect(cloneAuthFor('https://github.com/someone-else/x.git', TOKEN, [inst()])).toBeNull();
        expect(cloneAuthFor('https://github.com/ada/x.git', TOKEN, [inst({ permissions: { metadata: 'read' } })])).toBeNull();
        expect(cloneAuthFor('https://gitlab.com/ada/x.git', TOKEN, [inst()])).toBeNull();
        // An SSH URL of a covered account is no longer left alone: it clones over HTTPS with the sign-in (Add workspace
        // parity item 8, Genie 1's githubCloneAuth) — test/github-browse-fork-core.test.ts.
        expect(cloneAuthFor('git@github.com:ada/x.git', TOKEN, [inst()])?.url).toBe('https://github.com/ada/x.git');
        expect(cloneAuthFor('https://github.com/ada/x.git', TOKEN, null)).toBeNull();
    });

    it('redaction replaces every occurrence of every secret', () => {
        expect(redactSecrets(`fatal: header ${TOKEN} and ${basic} and ${TOKEN}`, [TOKEN, basic])).toBe('fatal: header *** and *** and ***');
        expect(redactSecrets('nothing here', [])).toBe('nothing here');
    });
});
