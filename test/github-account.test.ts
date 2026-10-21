import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITHUB_INSTALL_URL } from '../src/core/github.js';
import { GithubAccount, type GithubAccountPorts, type GithubCipher } from '../src/main/github-account.js';

/**
 * THIS GENIE'S GITHUB SIGN-IN (beta.33 item 25, Tynn #780) — Genie 1's, carried over and ported.
 *
 * The owner (2026-10-20): "I already had github setup with this app with genie 1 so why is it not functional anymore?"
 *
 * MEASURED on the owner's machine before this was written (values never printed): Genie 1's `genie.db` (Chromium's
 * userData, `%APPDATA%\genie`) holds `github_token_enc` — a `v10` blob, base64 of Electron `safeStorage.encryptString`
 * — and `github_user`; no refresh token (the App does not expire user tokens). Genie 2 runs with the SAME userData (the
 * package is `genie` in both), so the same `Local State` key: unwrapping that key with DPAPI and AES-GCM-decrypting the
 * blob gave a 40-character `ghu_` token, and GitHub answered `GET /user/installations` with 200 and seven genie-aos
 * installations. So Genie 2's safeStorage decrypts Genie 1's login as it is; nobody signs in again.
 *
 * Here the cipher is a fake with a KEY (a blob made under another key does not decrypt, as with another OS user's
 * keychain), GitHub is a fake that answers like the real one, and the sleeps are recorded — the device flow polls at the
 * interval GitHub dictates (the protocol, RFC 8628, not a choice of ours).
 */

const TOKEN = 'ghu_exampletoken0000000000000000000000';
const NEW_TOKEN = 'ghu_freshtoken11111111111111111111111';

function cipher(key: string, available = true): GithubCipher & { encrypted: string[] } {
    const encrypted: string[] = [];
    const xor = (b: Buffer) => Buffer.from(b.map((c, i) => c ^ key.charCodeAt(i % key.length)));
    return {
        encrypted,
        isAvailable: () => available,
        encrypt: (text) => { encrypted.push(text); return Buffer.concat([Buffer.from(`${key}:`), xor(Buffer.from(text, 'utf8'))]); },
        decrypt: (bytes) => {
            const head = `${key}:`;
            if (bytes.subarray(0, head.length).toString() !== head) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
            return xor(bytes.subarray(head.length)).toString('utf8');
        },
    };
}

/** Genie 1's blob for a token: base64 of what safeStorage.encryptString returned. */
const v1Blob = (c: GithubCipher, token: string) => c.encrypt(token).toString('base64');

interface FakeGithub {
    calls: Array<{ method: string; url: string; auth: string | null; body?: string }>;
    accepts: Set<string>;
    polls: Array<Record<string, unknown>>;
    fetch: GithubAccountPorts['fetch'];
    reachable: boolean;
}

function fakeGithub(): FakeGithub {
    const gh: FakeGithub = {
        calls: [],
        accepts: new Set([TOKEN, NEW_TOKEN]),
        polls: [],
        reachable: true,
        fetch: async (url, init) => {
            if (!gh.reachable) throw new Error('getaddrinfo ENOTFOUND api.github.com');
            const auth = init.headers.Authorization ?? null;
            gh.calls.push({ method: init.method, url, auth, ...(init.body !== undefined ? { body: init.body } : {}) });
            const answer = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
            if (url === 'https://github.com/login/device/code') return answer(200, { device_code: 'dev-1', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 });
            if (url === 'https://github.com/login/oauth/access_token') return answer(200, gh.polls.shift() ?? { error: 'authorization_pending' });
            const token = auth?.replace(/^Bearer /, '') ?? '';
            if (!gh.accepts.has(token)) return answer(401, { message: 'Bad credentials' });
            if (url === 'https://api.github.com/user') return answer(200, { login: token === NEW_TOKEN ? 'grace' : 'ada', name: token === NEW_TOKEN ? 'Grace' : 'Ada' });
            if (url === 'https://api.github.com/user/installations?per_page=100') {
                return answer(200, { total_count: 2, installations: [
                    { id: 11, account: { login: 'ada', type: 'User' }, repository_selection: 'all', permissions: { metadata: 'read', contents: 'write', issues: 'read' } },
                    { id: 22, account: { login: 'Example-Org', type: 'Organization' }, repository_selection: 'selected', permissions: { metadata: 'read', issues: 'read' } },
                ] });
            }
            if (url.startsWith('https://api.github.com/user/installations/11/repositories')) return answer(200, { total_count: 40, repositories: [{ full_name: 'ada/one' }] });
            if (url.startsWith('https://api.github.com/user/installations/22/repositories')) return answer(200, { total_count: 2, repositories: [{ full_name: 'Example-Org/site' }, { full_name: 'Example-Org/api' }] });
            return answer(404, { message: 'Not Found' });
        },
    };
    return gh;
}

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-github-')); file = join(dir, 'github.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function ports(over: Partial<GithubAccountPorts> & { gh: FakeGithub }): GithubAccountPorts & { sleeps: number[]; opened: string[] } {
    const sleeps: number[] = [];
    const opened: string[] = [];
    return {
        file,
        cipher: cipher('k1'),
        fetch: over.gh.fetch,
        openExternal: async (url) => { opened.push(url); },
        sleep: async (ms, signal) => {
            sleeps.push(ms);
            if (signal.aborted) throw new Error('cancelled');
            await Promise.resolve();
            if (signal.aborted) throw new Error('cancelled');
        },
        ...over,
        sleeps,
        opened,
    };
}

describe('Genie 1’s login carries over', () => {
    it('decrypted with this Genie’s key and kept encrypted in its own file: signed in, said to come from Genie 1, no sign-in', async () => {
        const gh = fakeGithub();
        const c = cipher('k1');
        const p = ports({ gh, cipher: c, v1Settings: () => ({ github_token_enc: v1Blob(c, TOKEN), github_user: 'ada', github_refresh_enc: '' }) });
        const account = await GithubAccount.open(p);
        expect(account.view()).toMatchObject({ status: 'signed-in', user: { login: 'ada' }, device: null });
        // No migration label (the owner, 2026-10-21): the view does not say where the login came from.
        expect('carriedFromGenie1' in account.view()).toBe(false);
        const stored = await readFile(file, 'utf8');
        expect(stored).not.toContain(TOKEN);
        expect(JSON.parse(stored)).toMatchObject({ state: 'signed-in', login: 'ada', source: 'genie-1' });
        // Encrypted through the cipher, not merely encoded.
        expect(c.encrypted).toContain(TOKEN);
        // No device flow was started.
        expect(gh.calls.some((x) => x.url.startsWith('https://github.com/login/'))).toBe(false);
    });

    it('then reads the REAL status from GitHub: who, every installation, its repositories (listed when selected, counted when all), and the permissions granted', async () => {
        const gh = fakeGithub();
        const c = cipher('k1');
        const account = await GithubAccount.open(ports({ gh, cipher: c, v1Settings: () => ({ github_token_enc: v1Blob(c, TOKEN), github_user: 'ada' }) }));
        await account.refresh();
        const view = account.view();
        expect(view.user).toEqual({ login: 'ada', name: 'Ada' });
        expect(view.installations).toEqual([
            { id: 11, account: 'ada', isOrg: false, selection: 'all', repoCount: 40, repos: null, permissions: { metadata: 'read', contents: 'write', issues: 'read' }, settingsUrl: 'https://github.com/settings/installations/11' },
            { id: 22, account: 'Example-Org', isOrg: true, selection: 'selected', repoCount: 2, repos: ['Example-Org/site', 'Example-Org/api'], permissions: { metadata: 'read', issues: 'read' }, settingsUrl: 'https://github.com/organizations/Example-Org/settings/installations/22' },
        ]);
        expect(view.capabilities.find((r) => r.id === 'clone-private')).toMatchObject({ enabled: true });
        expect(view.signal).toBeNull();
        // Every API call carried the carried-over token.
        for (const call of gh.calls) expect(call.auth).toBe(`Bearer ${TOKEN}`);
    });

    it('a carried token GitHub no longer accepts: shown as needing a sign-in again, and the Deck is told', async () => {
        const gh = fakeGithub();
        gh.accepts.delete(TOKEN);
        const c = cipher('k1');
        const account = await GithubAccount.open(ports({ gh, cipher: c, v1Settings: () => ({ github_token_enc: v1Blob(c, TOKEN), github_user: 'ada' }) }));
        await account.refresh();
        expect(account.view()).toMatchObject({ status: 'expired', user: { login: 'ada' }, message: expect.stringMatching(/no longer accepts/i) });
        expect(account.view().signal).not.toBeNull();
    });

    it('a Genie 1 login this Genie cannot decrypt (another key): signed out, saying exactly why, nothing written', async () => {
        const gh = fakeGithub();
        const account = await GithubAccount.open(ports({ gh, cipher: cipher('k1'), v1Settings: () => ({ github_token_enc: v1Blob(cipher('other-user'), TOKEN), github_user: 'ada' }) }));
        expect(account.view()).toMatchObject({ status: 'signed-out', message: expect.stringMatching(/Genie 1.*cannot decrypt/i) });
        await expect(readFile(file, 'utf8')).rejects.toThrow();
    });

    it('OS encryption unavailable: Genie 1’s login is left where it is, and the reason is the encryption, not the login', async () => {
        const gh = fakeGithub();
        const k = cipher('k1');
        const account = await GithubAccount.open(ports({ gh, cipher: cipher('k1', false), v1Settings: () => ({ github_token_enc: v1Blob(k, TOKEN), github_user: 'ada' }) }));
        expect(account.view()).toMatchObject({ status: 'signed-out', message: expect.stringMatching(/encryption is unavailable/i) });
        await expect(readFile(file, 'utf8')).rejects.toThrow();
    });

    it('this Genie’s own sign-in wins over Genie 1’s; after Sign out, Genie 1’s is NOT imported again', async () => {
        const gh = fakeGithub();
        const c = cipher('k1');
        const v1 = () => ({ github_token_enc: v1Blob(c, TOKEN), github_user: 'ada' });
        const first = await GithubAccount.open(ports({ gh, cipher: c, v1Settings: v1 }));
        expect(first.view().status).toBe('signed-in');
        await first.signOut();
        expect(first.view()).toMatchObject({ status: 'signed-out', user: null });
        const stored = await readFile(file, 'utf8');
        expect(stored).not.toContain(TOKEN);
        expect(JSON.parse(stored)).toEqual({ version: 1, state: 'signed-out' });
        const again = await GithubAccount.open(ports({ gh, cipher: c, v1Settings: v1 }));
        expect(again.view().status).toBe('signed-out');
        expect(again.view().message).toBeNull();
    });

    it('a saved sign-in this Genie can no longer decrypt (the keychain changed): needs a sign-in again, in words', async () => {
        await writeFile(file, JSON.stringify({ version: 1, state: 'signed-in', login: 'ada', name: 'Ada', source: 'sign-in', tokenEnc: cipher('old').encrypt(TOKEN).toString('base64') }));
        const account = await GithubAccount.open(ports({ gh: fakeGithub(), cipher: cipher('k1') }));
        expect(account.view()).toMatchObject({ status: 'expired', user: { login: 'ada' }, message: expect.stringMatching(/cannot decrypt/i) });
    });
});

describe('signing in: Genie 1’s device flow', () => {
    it('one button: the code shown, the browser opened at GitHub’s page, polling at GitHub’s interval (slow_down obeyed), then signed in and read', async () => {
        const gh = fakeGithub();
        gh.polls.push({ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: NEW_TOKEN, token_type: 'bearer' });
        const p = ports({ gh });
        const account = await GithubAccount.open(p);
        const changes: string[] = [];
        account.onChange(() => changes.push(account.view().status));
        await account.startSignIn();
        expect(account.view()).toMatchObject({ status: 'signing-in', device: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device' } });
        expect(p.opened).toEqual(['https://github.com/login/device']);
        // The device-code request names Genie's App and asks no scope (a GitHub App's permissions live on the App).
        const codeCall = gh.calls.find((x) => x.url === 'https://github.com/login/device/code')!;
        expect(Object.fromEntries(new URLSearchParams(codeCall.body))).toEqual({ client_id: 'Iv23liPssWsCpaUIxtIT' });
        await account.signInSettled();
        // 5 s, 5 s (pending), then GitHub's slower 10 s.
        expect(p.sleeps).toEqual([5000, 5000, 10000]);
        expect(account.view()).toMatchObject({ status: 'signed-in', user: { login: 'grace', name: 'Grace' }, device: null, message: null });
        expect(account.view().installations).toHaveLength(2);
        expect(changes).toContain('signed-in');
        const stored = await readFile(file, 'utf8');
        expect(stored).not.toContain(NEW_TOKEN);
        expect(JSON.parse(stored)).toMatchObject({ state: 'signed-in', login: 'grace', source: 'sign-in' });
    });

    it('denied on GitHub: signed out, saying so', async () => {
        const gh = fakeGithub();
        gh.polls.push({ error: 'access_denied' });
        const account = await GithubAccount.open(ports({ gh }));
        await account.startSignIn();
        await account.signInSettled();
        expect(account.view()).toMatchObject({ status: 'signed-out', device: null, message: expect.stringMatching(/denied|cancelled/i) });
    });

    it('Cancel stops the polling: signed out, no message, and no more polls', async () => {
        const gh = fakeGithub();
        let release: () => void = () => {};
        const p = ports({ gh, sleep: (_ms, signal) => new Promise<void>((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled'))); }) });
        const account = await GithubAccount.open(p);
        await account.startSignIn();
        account.cancelSignIn();
        await account.signInSettled();
        release();
        expect(account.view()).toMatchObject({ status: 'signed-out', device: null, message: null });
        expect(gh.calls.filter((x) => x.url === 'https://github.com/login/oauth/access_token')).toHaveLength(0);
    });

    it('without OS encryption the sign-in is refused BEFORE GitHub is asked — a token that could only be kept in the clear is never minted', async () => {
        const gh = fakeGithub();
        const account = await GithubAccount.open(ports({ gh, cipher: cipher('k1', false) }));
        await account.startSignIn();
        expect(gh.calls).toEqual([]);
        expect(account.view()).toMatchObject({ status: 'signed-out', message: expect.stringMatching(/encryption is unavailable/i) });
    });

    it('GitHub unreachable: the reason in words, still signed out', async () => {
        const gh = fakeGithub();
        gh.reachable = false;
        const account = await GithubAccount.open(ports({ gh }));
        await account.startSignIn();
        expect(account.view()).toMatchObject({ status: 'signed-out', message: expect.stringMatching(/could not be reached/i) });
    });
});

describe('the token never leaves main', () => {
    it('no view, message or change carries it — signed in, signing in, expired', async () => {
        const gh = fakeGithub();
        const c = cipher('k1');
        const account = await GithubAccount.open(ports({ gh, cipher: c, v1Settings: () => ({ github_token_enc: v1Blob(c, TOKEN), github_user: 'ada' }) }));
        await account.refresh();
        expect(JSON.stringify(account.view())).not.toContain(TOKEN);
        gh.accepts.delete(TOKEN);
        await account.refresh();
        expect(JSON.stringify(account.view())).not.toContain(TOKEN);
    });

    it('the clone credential is handed out only for a repository of an account the App is installed on with Contents', async () => {
        const gh = fakeGithub();
        const c = cipher('k1');
        const account = await GithubAccount.open(ports({ gh, cipher: c, v1Settings: () => ({ github_token_enc: v1Blob(c, TOKEN), github_user: 'ada' }) }));
        // GitHub not read yet: no installation is known, so nothing is claimed.
        expect(account.cloneAuth('https://github.com/ada/one.git')).toBeNull();
        await account.refresh();
        expect(account.cloneAuth('https://github.com/ada/one.git')?.secrets[0]).toBe(TOKEN);
        // Example-Org's installation has no Contents.
        expect(account.cloneAuth('https://github.com/Example-Org/site.git')).toBeNull();
        await account.signOut();
        expect(account.cloneAuth('https://github.com/ada/one.git')).toBeNull();
    });
});

describe('the pages a person goes to', () => {
    it('install on more repositories, one installation’s own page, and GitHub’s device page — Genie’s own URLs, never one the window sends', async () => {
        const gh = fakeGithub();
        const c = cipher('k1');
        const p = ports({ gh, cipher: c, v1Settings: () => ({ github_token_enc: v1Blob(c, TOKEN), github_user: 'ada' }) });
        const account = await GithubAccount.open(p);
        await account.refresh();
        await account.openPage({ page: 'install' });
        await account.openPage({ page: 'installation', installationId: 22 });
        await account.openPage({ page: 'installation', installationId: 999 });
        expect(p.opened).toEqual([GITHUB_INSTALL_URL, 'https://github.com/organizations/Example-Org/settings/installations/22']);
    });
});
