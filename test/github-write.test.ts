import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubApiError, GithubAuthError, GithubNotInstalledError, githubErrorMessage, githubInstallUrl, pollOutcomeFrom, rateLimitWaitMs, refreshOutcomeFrom } from '../src/core/github.js';
import { GithubAccount, type GithubAccountPorts, type GithubCipher } from '../src/main/github-account.js';

/**
 * THE GITHUB WRITE CLIENT (add-workspace parity item 9) — Genie 1's, ported: the foundation the owner picker, creating the
 * `<slug>.agi` repository and forking (items 10–12) stand on.
 *
 * Genie 1 (`v1:main/github/api.ts`) wrote with the device-flow GitHub App USER token on the desktop: `POST /user/repos`,
 * `POST /orgs/{org}/repos`, `POST /repos/{o}/{r}/forks`. Its client sent JSON with the token header; surfaced GitHub's own
 * message (folding in `errors[]`, where the real cause lives — "name already exists on this account"); kept the refresh
 * token encrypted beside the access token and exchanged it when the access token expired (one exchange for every caller:
 * GitHub rotates the refresh token on use); turned a 403/404 on a write into "Genie isn't installed on <account>" with the
 * install chooser pre-targeted at that account; and reused the repository a failed earlier run left behind (422 "already
 * exists"). Genie 2's account read GitHub (GET only) and kept no refresh token. Here GitHub is a fake that answers like the
 * real one; no test reaches the network.
 */

const TOKEN = 'ghu_exampletoken0000000000000000000000';
const NEW_TOKEN = 'ghu_freshtoken11111111111111111111111';
const REFRESH = 'ghr_examplerefresh00000000000000000000000000000000000000000000000000000000000';
const NEW_REFRESH = 'ghr_freshrefresh111111111111111111111111111111111111111111111111111111111111';
const SECRETS = [TOKEN, NEW_TOKEN, REFRESH, NEW_REFRESH];
const NOW = 1_800_000_000_000;

function cipher(key: string): GithubCipher {
    const xor = (b: Buffer) => Buffer.from(b.map((c, i) => c ^ key.charCodeAt(i % key.length)));
    return {
        isAvailable: () => true,
        encrypt: (text) => Buffer.concat([Buffer.from(`${key}:`), xor(Buffer.from(text, 'utf8'))]),
        decrypt: (bytes) => {
            const head = `${key}:`;
            if (bytes.subarray(0, head.length).toString() !== head) throw new Error('cannot decrypt');
            return xor(bytes.subarray(head.length)).toString('utf8');
        },
    };
}
const C = cipher('k1');
const enc = (text: string) => C.encrypt(text).toString('base64');
const dec = (blob: string) => C.decrypt(Buffer.from(blob, 'base64'));

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
interface Call { method: string; url: string; headers: Record<string, string>; body?: string }

/** GitHub, faked: `routes` answer by "METHOD url"; a queue per route answers in turn, the last answer repeating. */
function fakeGithub(routes: Record<string, Answer | Answer[]>) {
    const calls: Call[] = [];
    const accepts = new Set([TOKEN, NEW_TOKEN]);
    const fetch: GithubAccountPorts['fetch'] = async (url, init) => {
        calls.push({ method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
        const respond = (a: Answer) => {
            const h = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
            return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
        };
        const key = `${init.method} ${url}`;
        const route = routes[key];
        if (!url.startsWith('https://github.com/login/')) {
            const token = init.headers.Authorization?.replace(/^Bearer /, '') ?? '';
            if (!accepts.has(token)) return respond({ status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' } });
        }
        if (route === undefined) {
            if (key === 'GET https://api.github.com/user') return respond({ status: 200, body: { login: 'ada', name: 'Ada' } });
            return respond({ status: 404, body: { message: 'Not Found' } });
        }
        if (Array.isArray(route)) return respond(route.length > 1 ? route.shift()! : route[0]!);
        return respond(route);
    };
    return { calls, accepts, fetch };
}

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-github-write-')); file = join(dir, 'github.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function signedIn(over: { accessExpiresAt?: number; refreshExpiresAt?: number; refresh?: string | null; token?: string } = {}) {
    await writeFile(file, JSON.stringify({
        version: 1, state: 'signed-in', login: 'ada', name: 'Ada', source: 'sign-in', tokenEnc: enc(over.token ?? TOKEN),
        ...(over.refresh === null ? {} : { refreshEnc: enc(over.refresh ?? REFRESH) }),
        ...(over.accessExpiresAt !== undefined ? { accessExpiresAt: over.accessExpiresAt } : {}),
        ...(over.refreshExpiresAt !== undefined ? { refreshExpiresAt: over.refreshExpiresAt } : {}),
    }));
}

function open(gh: ReturnType<typeof fakeGithub>, extra: Partial<GithubAccountPorts> = {}) {
    const sleeps: number[] = [];
    return {
        sleeps,
        account: GithubAccount.open({
            file, cipher: C, fetch: gh.fetch, now: () => NOW,
            sleep: async (ms) => { sleeps.push(ms); },
            ...extra,
        }),
    };
}

const REPO = (owner: string, name: string, priv = true) => ({ full_name: `${owner}/${name}`, clone_url: `https://github.com/${owner}/${name}.git`, html_url: `https://github.com/${owner}/${name}`, default_branch: 'main', private: priv });
const NAME_EXISTS = { status: 422, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }], documentation_url: 'https://docs.github.com/rest/repos/repos#create-a-repository-for-the-authenticated-user', status: '422' } };

describe('a write goes to GitHub as JSON with the token', () => {
    it('createRepo for the signed-in person: POST /user/repos, the JSON body, the token header, GitHub’s answer handed back', async () => {
        await signedIn();
        const gh = fakeGithub({ 'POST https://api.github.com/user/repos': { status: 201, body: REPO('ada', 'site.agi') } });
        const account = await open(gh).account;
        const repo = await account.createRepo({ owner: 'ada', name: 'site.agi', private: true });
        expect(repo).toEqual({ fullName: 'ada/site.agi', cloneUrl: 'https://github.com/ada/site.agi.git', htmlUrl: 'https://github.com/ada/site.agi', defaultBranch: 'main', private: true, created: true });
        const post = gh.calls.find((c) => c.method === 'POST')!;
        expect(post.url).toBe('https://api.github.com/user/repos');
        expect(post.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
        expect(JSON.parse(post.body!)).toEqual({ name: 'site.agi', private: true, auto_init: false, description: '' });
    });

    it('for an organization: POST /orgs/{org}/repos (the owner’s case kept), public when asked', async () => {
        await signedIn();
        const gh = fakeGithub({ 'POST https://api.github.com/orgs/Example-Org/repos': { status: 201, body: REPO('Example-Org', 'site.agi', false) } });
        const account = await open(gh).account;
        const repo = await account.createRepo({ owner: 'Example-Org', name: 'site.agi', private: false });
        expect(repo).toMatchObject({ fullName: 'Example-Org/site.agi', private: false, created: true });
        const post = gh.calls.find((c) => c.method === 'POST')!;
        expect(post.url).toBe('https://api.github.com/orgs/Example-Org/repos');
        expect(JSON.parse(post.body!)).toMatchObject({ name: 'site.agi', private: false });
        // Positive control for "user vs org": the person's own login (any case) is NOT an org.
        const gh2 = fakeGithub({ 'POST https://api.github.com/user/repos': { status: 201, body: REPO('ada', 'x') } });
        await (await open(gh2).account).createRepo({ owner: 'ADA', name: 'x', private: true });
        expect(gh2.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['https://api.github.com/user/repos']);
    });

    it('signed out: refused before GitHub is asked, in words', async () => {
        const gh = fakeGithub({});
        const account = await open(gh).account;
        await expect(account.createRepo({ owner: 'ada', name: 'x', private: true })).rejects.toBeInstanceOf(GithubAuthError);
        expect(gh.calls).toEqual([]);
    });
});

describe('GitHub’s errors, honestly', () => {
    it('the status and GitHub’s own message, with errors[] folded in (where the real cause is)', () => {
        expect(githubErrorMessage(422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }, { message: 'name is too long' }] }, ''))
            .toBe('GitHub answered 422: Validation Failed — Repository name invalid; name is too long');
        expect(githubErrorMessage(502, null, '<html>Bad gateway</html>')).toBe('GitHub answered 502: <html>Bad gateway</html>');
        expect(githubErrorMessage(500, null, '')).toBe('GitHub answered 500');
    });

    it('a 422 that is NOT "already exists" is thrown as GitHub said it, not reused', async () => {
        await signedIn();
        const gh = fakeGithub({ 'POST https://api.github.com/user/repos': { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }] } } });
        const account = await open(gh).account;
        const error = await account.createRepo({ owner: 'ada', name: 'bad name', private: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubApiError);
        expect(error).toMatchObject({ status: 422, message: 'GitHub answered 422: Validation Failed — Repository name invalid' });
        expect(gh.calls.some((c) => c.method === 'GET' && c.url.includes('/repos/'))).toBe(false);
    });
});

describe('422 "name already exists": the repository an earlier run made is reused (Genie 1)', () => {
    it('read back and handed over as not created', async () => {
        await signedIn();
        const gh = fakeGithub({
            'POST https://api.github.com/orgs/Example-Org/repos': NAME_EXISTS,
            'GET https://api.github.com/repos/Example-Org/site.agi': { status: 200, body: REPO('Example-Org', 'site.agi') },
        });
        const account = await open(gh).account;
        const repo = await account.createRepo({ owner: 'Example-Org', name: 'site.agi', private: true });
        expect(repo).toEqual({ fullName: 'Example-Org/site.agi', cloneUrl: 'https://github.com/Example-Org/site.agi.git', htmlUrl: 'https://github.com/Example-Org/site.agi', defaultBranch: 'main', private: true, created: false });
    });
});

describe('not installed on that account: the error carries the install URL for it', () => {
    it('a 403 on an org write → GithubNotInstalledError, the chooser pre-targeted at the account’s id, GitHub’s words kept', async () => {
        await signedIn();
        const gh = fakeGithub({
            'POST https://api.github.com/orgs/Other-Org/repos': { status: 403, body: { message: 'Resource not accessible by integration' } },
            'GET https://api.github.com/users/Other-Org': { status: 200, body: { login: 'Other-Org', id: 4242, type: 'Organization' } },
        });
        const account = await open(gh).account;
        const error = await account.createRepo({ owner: 'Other-Org', name: 'site.agi', private: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubNotInstalledError);
        expect(error).toMatchObject({ code: 'not_installed', account: 'Other-Org', status: 403, installUrl: 'https://github.com/apps/genie-aos/installations/new?suggested_target_id=4242' });
        expect((error as Error).message).toMatch(/Resource not accessible by integration/);
    });

    it('the account’s id unknown: the plain chooser; a 404 counts as not installed too', async () => {
        await signedIn();
        const gh = fakeGithub({ 'POST https://api.github.com/user/repos': { status: 404, body: { message: 'Not Found' } } , 'GET https://api.github.com/users/ada': { status: 500, body: { message: 'boom' } } });
        const account = await open(gh).account;
        const error = await account.createRepo({ owner: 'ada', name: 'site.agi', private: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubNotInstalledError);
        expect(error).toMatchObject({ account: 'ada', installUrl: 'https://github.com/apps/genie-aos/installations/new' });
        expect(githubInstallUrl(7)).toBe('https://github.com/apps/genie-aos/installations/new?suggested_target_id=7');
        expect(githubInstallUrl(null)).toBe('https://github.com/apps/genie-aos/installations/new');
    });
});

describe('rate limits are honoured', () => {
    it('a primary limit (403, remaining 0) resetting soon: waits until the reset, then sends again — not mistaken for "not installed"', async () => {
        await signedIn();
        const gh = fakeGithub({
            'POST https://api.github.com/user/repos': [
                { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 20) } },
                { status: 201, body: REPO('ada', 'site.agi') },
            ],
        });
        const o = open(gh);
        const repo = await (await o.account).createRepo({ owner: 'ada', name: 'site.agi', private: true });
        expect(repo.created).toBe(true);
        expect(o.sleeps).toEqual([20_000]);
        expect(gh.calls.filter((c) => c.method === 'POST' && c.url.includes('/user/repos'))).toHaveLength(2);
    });

    it('a secondary limit (429 Retry-After) waits what GitHub says; a reset too far off is an error naming the wait, sent no more', async () => {
        expect(rateLimitWaitMs(429, { get: (n) => (n === 'retry-after' ? '7' : null) }, NOW)).toBe(7000);
        expect(rateLimitWaitMs(403, { get: (n) => (n === 'x-ratelimit-remaining' ? '0' : n === 'x-ratelimit-reset' ? String(NOW / 1000 + 5) : null) }, NOW)).toBe(5000);
        // Positive control: an ordinary 403 is not a rate limit.
        expect(rateLimitWaitMs(403, { get: () => null }, NOW)).toBeNull();
        await signedIn();
        const gh = fakeGithub({ 'POST https://api.github.com/user/repos': { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 1800) } } });
        const o = open(gh);
        const error = await (await o.account).createRepo({ owner: 'ada', name: 'x', private: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubApiError);
        expect(error).not.toBeInstanceOf(GithubNotInstalledError);
        expect((error as Error).message).toMatch(/rate limit.*30 min/i);
        expect(o.sleeps).toEqual([]);
        expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });
});

describe('the refresh token: kept encrypted beside the access token, exchanged when it expires', () => {
    it('a sign-in keeps what GitHub hands over: the refresh token and both expiries (parsed), encrypted at rest', () => {
        expect(pollOutcomeFrom({ access_token: 'ghu_x', refresh_token: 'ghr_y', expires_in: 28800, refresh_token_expires_in: '15811200', token_type: 'bearer' }))
            .toEqual({ kind: 'token', token: 'ghu_x', refreshToken: 'ghr_y', expiresIn: 28800, refreshExpiresIn: 15811200 });
        expect(refreshOutcomeFrom({ access_token: 'ghu_x', refresh_token: 'ghr_y', expires_in: 28800 })).toEqual({ kind: 'token', token: 'ghu_x', refreshToken: 'ghr_y', expiresIn: 28800 });
        expect(refreshOutcomeFrom({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' })).toEqual({ kind: 'rejected', code: 'bad_refresh_token', description: 'The refresh token passed is incorrect or expired.' });
    });

    it('the device flow stores the refresh token encrypted, with absolute expiries', async () => {
        const gh = fakeGithub({
            'POST https://github.com/login/device/code': { status: 200, body: { device_code: 'd', user_code: 'U-1', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } },
            'POST https://github.com/login/oauth/access_token': { status: 200, body: { access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 28800, refresh_token_expires_in: 15811200, token_type: 'bearer' } },
            'GET https://api.github.com/user/installations?per_page=100': { status: 200, body: { installations: [] } },
        });
        const account = await open(gh).account;
        await account.startSignIn();
        await account.signInSettled();
        expect(account.view().status).toBe('signed-in');
        const text = await readFile(file, 'utf8');
        for (const s of SECRETS) expect(text).not.toContain(s);
        const stored = JSON.parse(text) as { tokenEnc: string; refreshEnc: string; accessExpiresAt: number; refreshExpiresAt: number };
        expect(dec(stored.tokenEnc)).toBe(NEW_TOKEN);
        expect(dec(stored.refreshEnc)).toBe(NEW_REFRESH);
        expect(stored.accessExpiresAt).toBe(NOW + 28800_000);
        expect(stored.refreshExpiresAt).toBe(NOW + 15811200_000);
    });

    it('Genie 1’s refresh token and expiries carry over with its login', async () => {
        const gh = fakeGithub({});
        await GithubAccount.open({ file, cipher: C, fetch: gh.fetch, now: () => NOW, v1Settings: () => ({ github_token_enc: enc(TOKEN), github_user: 'ada', github_refresh_enc: enc(REFRESH), github_token_exp_ms: String(NOW + 1000), github_refresh_exp_ms: String(NOW + 9000) }) });
        const stored = JSON.parse(await readFile(file, 'utf8')) as { refreshEnc: string; accessExpiresAt: number; refreshExpiresAt: number };
        expect(dec(stored.refreshEnc)).toBe(REFRESH);
        expect(stored).toMatchObject({ accessExpiresAt: NOW + 1000, refreshExpiresAt: NOW + 9000 });
    });

    it('an expired access token is exchanged BEFORE the write (one exchange for concurrent writes), the new pair saved, the write sent with the new token', async () => {
        await signedIn({ accessExpiresAt: NOW - 1, refreshExpiresAt: NOW + 1e9 });
        const gh = fakeGithub({
            'POST https://github.com/login/oauth/access_token': { status: 200, body: { access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 28800, refresh_token_expires_in: 15811200 } },
            'POST https://api.github.com/user/repos': { status: 201, body: REPO('ada', 'a') },
        });
        gh.accepts.delete(TOKEN);
        const account = await open(gh).account;
        await Promise.all([account.createRepo({ owner: 'ada', name: 'a', private: true }), account.createRepo({ owner: 'ada', name: 'b', private: true })]);
        const exchanges = gh.calls.filter((c) => c.url === 'https://github.com/login/oauth/access_token');
        expect(exchanges).toHaveLength(1);
        expect(Object.fromEntries(new URLSearchParams(exchanges[0]!.body))).toEqual({ client_id: 'Iv23liPssWsCpaUIxtIT', grant_type: 'refresh_token', refresh_token: REFRESH });
        const posts = gh.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://api.github.com/'));
        expect(posts.map((c) => c.headers.Authorization)).toEqual([`Bearer ${NEW_TOKEN}`, `Bearer ${NEW_TOKEN}`]);
        const stored = JSON.parse(await readFile(file, 'utf8')) as { tokenEnc: string; refreshEnc: string; accessExpiresAt: number };
        expect(dec(stored.tokenEnc)).toBe(NEW_TOKEN);
        expect(dec(stored.refreshEnc)).toBe(NEW_REFRESH);
        expect(stored.accessExpiresAt).toBe(NOW + 28800_000);
        expect(account.view().status).toBe('signed-in');
    });

    it('a 401 on a token not yet due: exchanged once and the write sent again', async () => {
        await signedIn({ accessExpiresAt: NOW + 1e6 });
        const gh = fakeGithub({
            'POST https://github.com/login/oauth/access_token': { status: 200, body: { access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 28800 } },
            'POST https://api.github.com/user/repos': { status: 201, body: REPO('ada', 'a') },
        });
        gh.accepts.delete(TOKEN);
        const account = await open(gh).account;
        await expect(account.createRepo({ owner: 'ada', name: 'a', private: true })).resolves.toMatchObject({ created: true });
        expect(gh.calls.filter((c) => c.url === 'https://api.github.com/user/repos').map((c) => c.headers.Authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEW_TOKEN}`]);
    });

    it('GitHub REFUSES the refresh token: needs a sign-in again, GitHub’s own words shown, nothing sent with a dead token', async () => {
        await signedIn({ accessExpiresAt: NOW - 1 });
        const gh = fakeGithub({ 'POST https://github.com/login/oauth/access_token': { status: 200, body: { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' } } });
        const account = await open(gh).account;
        const error = await account.createRepo({ owner: 'ada', name: 'a', private: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubAuthError);
        expect(account.view()).toMatchObject({ status: 'expired', message: expect.stringMatching(/The refresh token passed is incorrect or expired\..*Sign in again/) });
        expect(account.view().signal).not.toBeNull();
        expect(gh.calls.some((c) => c.url.startsWith('https://api.github.com/'))).toBe(false);
    });

    it('incorrect_client_credentials (genie#263: GitHub wants the App’s client secret to refresh, and Genie ships none): said as that, not as a dead token', async () => {
        await signedIn({ accessExpiresAt: NOW - 1 });
        const gh = fakeGithub({ 'POST https://github.com/login/oauth/access_token': { status: 200, body: { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' } } });
        const account = await open(gh).account;
        await expect(account.createRepo({ owner: 'ada', name: 'a', private: true })).rejects.toBeInstanceOf(GithubAuthError);
        expect(account.view().message).toMatch(/client secret/i);
    });

    it('a refresh token past its own expiry, or none at all: needs a sign-in, without asking GitHub', async () => {
        await signedIn({ accessExpiresAt: NOW - 1, refreshExpiresAt: NOW - 1 });
        const gh = fakeGithub({});
        const account = await open(gh).account;
        await expect(account.createRepo({ owner: 'ada', name: 'a', private: true })).rejects.toBeInstanceOf(GithubAuthError);
        expect(account.view()).toMatchObject({ status: 'expired', message: expect.stringMatching(/Sign in again/) });
        expect(gh.calls).toEqual([]);
        await signedIn({ accessExpiresAt: NOW - 1, refresh: null });
        const account2 = await open(gh).account;
        await expect(account2.createRepo({ owner: 'ada', name: 'a', private: true })).rejects.toBeInstanceOf(GithubAuthError);
        expect(account2.view().status).toBe('expired');
        expect(gh.calls).toEqual([]);
    });

    it('a TRANSIENT refresh failure (GitHub 502): an error saying try again — the sign-in is NOT thrown away', async () => {
        await signedIn({ accessExpiresAt: NOW - 1 });
        const gh = fakeGithub({ 'POST https://github.com/login/oauth/access_token': { status: 502, body: { message: 'Bad Gateway' } } });
        const account = await open(gh).account;
        const error = await account.createRepo({ owner: 'ada', name: 'a', private: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubApiError);
        expect(error).not.toBeInstanceOf(GithubAuthError);
        expect((error as Error).message).toMatch(/could not renew.*502.*try again/i);
        expect(account.view().status).toBe('signed-in');
        const stored = JSON.parse(await readFile(file, 'utf8')) as { refreshEnc: string };
        expect(dec(stored.refreshEnc)).toBe(REFRESH);
    });
});

describe('tokens are never logged, thrown or shown', () => {
    it('across a refresh, a write, a refused refresh and a not-installed error: no console line, error or view carries a token', async () => {
        const lines: string[] = [];
        for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
        // Positive control: the spy does catch what is logged, a token included.
        console.warn('probe', TOKEN);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(TOKEN);
        lines.length = 0;

        const thrown: unknown[] = [];
        await signedIn({ accessExpiresAt: NOW - 1 });
        const gh = fakeGithub({
            'POST https://github.com/login/oauth/access_token': [{ status: 200, body: { access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 28800 } }, { status: 200, body: { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' } }],
            'POST https://api.github.com/user/repos': { status: 201, body: REPO('ada', 'a') },
            'POST https://api.github.com/orgs/Other-Org/repos': { status: 403, body: { message: 'Resource not accessible by integration' } },
        });
        const account = await open(gh).account;
        await account.createRepo({ owner: 'ada', name: 'a', private: true });
        await account.createRepo({ owner: 'Other-Org', name: 'a', private: true }).catch((e: unknown) => thrown.push(e));
        gh.accepts.delete(NEW_TOKEN);
        await account.createRepo({ owner: 'ada', name: 'b', private: true }).catch((e: unknown) => thrown.push(e));
        expect(thrown).toHaveLength(2);
        const everything = [...lines, ...thrown.map((e) => `${(e as Error).message}\n${(e as Error).stack}\n${JSON.stringify(e)}`), JSON.stringify(account.view())].join('\n');
        for (const s of SECRETS) expect(everything).not.toContain(s);
    });
});
