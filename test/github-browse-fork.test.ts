import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GithubApiError, GithubNotInstalledError } from '../src/core/github.js';
import { GithubAccount, type GithubAccountPorts, type GithubCipher } from '../src/main/github-account.js';

/**
 * ADD WORKSPACE PARITY ITEMS 8 + 12 — the GitHub sign-in's half.
 *
 * (8) Genie 1 listed every repository its GitHub App user token could reach (`v1:main/github/api.ts:409-452`): each
 * installation's repositories, page by page (`/user/installations/{id}/repositories?per_page=100&page=n` until a short
 * page), so Import from Git could be picked rather than pasted. Genie 2 read full names only for "selected"
 * installations and, for an "all" installation, only a count.
 *
 * (12) Genie 1 forked into the chosen owner (`api.ts:1118-1134`): `POST /repos/{o}/{r}/forks`, `organization` in the body
 * for an org, a 403/404 read as "Genie is not installed there". GitHub makes a fork asynchronously; Genie 2 waits until it
 * has its commits (polled with growing waits, bounded) before anything clones it.
 *
 * GitHub is a fake that answers like the real one; no test reaches the network.
 */

const TOKEN = 'ghu_exampletoken0000000000000000000000';
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

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
interface Call { method: string; url: string; body?: string }

/** GitHub, faked: `routes` answer by "METHOD url"; a queue per route answers in turn, the last answer repeating. */
function fakeGithub(routes: Record<string, Answer | Answer[]>) {
    const calls: Call[] = [];
    const fetch: GithubAccountPorts['fetch'] = async (url, init) => {
        calls.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}) });
        const respond = (a: Answer) => {
            const h = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
            return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
        };
        if (init.headers.Authorization !== `Bearer ${TOKEN}`) return respond({ status: 401, body: { message: 'Bad credentials' } });
        const key = `${init.method} ${url}`;
        const route = routes[key];
        if (route === undefined) {
            if (key === 'GET https://api.github.com/user') return respond({ status: 200, body: { login: 'ada', name: 'Ada' } });
            return respond({ status: 404, body: { message: 'Not Found' } });
        }
        if (Array.isArray(route)) return respond(route.length > 1 ? route.shift()! : route[0]!);
        return respond(route);
    };
    return { calls, fetch };
}

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-github-browse-')); file = join(dir, 'github.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function signedIn() {
    await writeFile(file, JSON.stringify({ version: 1, state: 'signed-in', login: 'ada', name: 'Ada', source: 'sign-in', tokenEnc: C.encrypt(TOKEN).toString('base64') }));
}
async function open(gh: ReturnType<typeof fakeGithub>) {
    const sleeps: number[] = [];
    const account = await GithubAccount.open({ file, cipher: C, fetch: gh.fetch, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } });
    return { account, sleeps };
}

const API = 'https://api.github.com';
const INSTALLS = (page = 1) => `GET ${API}/user/installations?per_page=100&page=${page}`;
const REPOS = (id: number, page: number) => `GET ${API}/user/installations/${id}/repositories?per_page=100&page=${page}`;
const repoJson = (owner: string, name: string, priv: boolean) => ({ id: name.length, name, full_name: `${owner}/${name}`, private: priv, clone_url: `https://github.com/${owner}/${name}.git`, default_branch: 'main', owner: { login: owner } });
const installation = (id: number, login: string, isOrg: boolean, selection: 'all' | 'selected') => ({ id, account: { login, type: isOrg ? 'Organization' : 'User' }, repository_selection: selection, permissions: { contents: 'read', metadata: 'read' } });

describe('Import from Git: the repositories the sign-in can reach, to pick from', () => {
    it('every installation, every page (an "all" installation listed too, not just counted), private marked, de-duplicated, sorted', async () => {
        await signedIn();
        const first = Array.from({ length: 100 }, (_, i) => repoJson('ada', `r${String(i).padStart(3, '0')}`, i % 2 === 0));
        const second = Array.from({ length: 50 }, (_, i) => repoJson('ada', `r${String(100 + i).padStart(3, '0')}`, false));
        const gh = fakeGithub({
            [INSTALLS(1)]: { status: 200, body: { total_count: 2, installations: [installation(1, 'ada', false, 'all'), installation(2, 'Example-Org', true, 'selected')] } },
            [REPOS(1, 1)]: { status: 200, body: { total_count: 150, repositories: first } },
            [REPOS(1, 2)]: { status: 200, body: { total_count: 150, repositories: second } },
            // A repository two installations both reach is listed once.
            [REPOS(2, 1)]: { status: 200, body: { total_count: 2, repositories: [repoJson('Example-Org', 'site', true), repoJson('ada', 'r000', true)] } },
        });
        const { account } = await open(gh);
        const listing = await account.repoListing();
        expect(listing.status).toBe('listed');
        if (listing.status !== 'listed') return;
        // COUNTED: 150 of ada's (both pages) + Example-Org/site; the duplicate ada/r000 once.
        expect(listing.repos).toHaveLength(151);
        expect(listing.truncated).toBe(false);
        expect(listing.repos[0]).toEqual({ fullName: 'ada/r000', owner: 'ada', name: 'r000', private: true, cloneUrl: 'https://github.com/ada/r000.git', defaultBranch: 'main' });
        expect(listing.repos.map((r) => r.fullName)).toContain('ada/r149');
        expect(listing.repos[listing.repos.length - 1]!.fullName).toBe('Example-Org/site');
        expect(listing.repos.find((r) => r.fullName === 'ada/r001')!.private).toBe(false);
        // The second page was asked for, and no third (the second was short).
        expect(gh.calls.map((c) => c.url)).toContain(`${API}/user/installations/1/repositories?per_page=100&page=2`);
        expect(gh.calls.map((c) => c.url)).not.toContain(`${API}/user/installations/1/repositories?per_page=100&page=3`);
    });

    it('the installations list is paged as well', async () => {
        await signedIn();
        const many = Array.from({ length: 100 }, (_, i) => installation(100 + i, `org${i}`, true, 'selected'));
        const routes: Record<string, Answer | Answer[]> = {
            [INSTALLS(1)]: { status: 200, body: { total_count: 101, installations: many } },
            [INSTALLS(2)]: { status: 200, body: { total_count: 101, installations: [installation(1, 'ada', false, 'all')] } },
            [REPOS(1, 1)]: { status: 200, body: { total_count: 1, repositories: [repoJson('ada', 'only-on-page-two', false)] } },
        };
        for (let i = 0; i < 100; i++) routes[REPOS(100 + i, 1)] = { status: 200, body: { total_count: 0, repositories: [] } };
        const { account } = await open(fakeGithub(routes));
        const listing = await account.repoListing();
        expect(listing.status === 'listed' ? listing.repos.map((r) => r.fullName) : listing).toEqual(['ada/only-on-page-two']);
    });

    it('a listing too long to read whole stops at its bound and SAYS it is cut short', async () => {
        await signedIn();
        const routes: Record<string, Answer | Answer[]> = { [INSTALLS(1)]: { status: 200, body: { total_count: 1, installations: [installation(1, 'ada', false, 'all')] } } };
        for (let p = 1; p <= 60; p++) routes[REPOS(1, p)] = { status: 200, body: { total_count: 9999, repositories: Array.from({ length: 100 }, (_, i) => repoJson('ada', `p${p}-${i}`, false)) } };
        const gh = fakeGithub(routes);
        const { account } = await open(gh);
        const listing = await account.repoListing();
        expect(listing.status).toBe('listed');
        if (listing.status !== 'listed') return;
        expect(listing.truncated).toBe(true);
        expect(listing.repos.length).toBeGreaterThan(0);
        expect(listing.repos.length).toBeLessThan(9999);
        const pages = gh.calls.filter((c) => c.url.includes('/installations/1/repositories')).length;
        expect(pages).toBeLessThanOrEqual(50);
    });

    it('signed out: says so, and GitHub is not asked', async () => {
        const gh = fakeGithub({});
        const { account } = await open(gh);
        expect(await account.repoListing()).toEqual({ status: 'signed-out' });
        expect(gh.calls).toEqual([]);
    });

    it('the App installed nowhere: says so (the screen offers the install), not an empty list', async () => {
        await signedIn();
        const { account } = await open(fakeGithub({ [INSTALLS(1)]: { status: 200, body: { total_count: 0, installations: [] } } }));
        expect(await account.repoListing()).toEqual({ status: 'not-installed' });
    });

    it('GitHub refusing a page: a failure in GitHub’s own words, not a short list passed off as whole', async () => {
        await signedIn();
        const { account } = await open(fakeGithub({
            [INSTALLS(1)]: { status: 200, body: { total_count: 1, installations: [installation(1, 'ada', false, 'all')] } },
            [REPOS(1, 1)]: { status: 500, body: { message: 'Server Error' } },
        }));
        const listing = await account.repoListing();
        expect(listing.status).toBe('failed');
        expect(listing.status === 'failed' ? listing.message : '').toMatch(/GitHub answered 500: Server Error/);
        expect(JSON.stringify(listing)).not.toContain(TOKEN);
    });
});

const FORKED = (owner: string, name: string) => ({ full_name: `${owner}/${name}`, clone_url: `https://github.com/${owner}/${name}.git`, html_url: `https://github.com/${owner}/${name}`, default_branch: 'main', private: true, fork: true });

describe('Fork into the chosen owner (Genie 1 forkRepo)', () => {
    it('into an organization: POST /repos/{o}/{r}/forks with `organization`, the fork GitHub made handed back', async () => {
        await signedIn();
        const gh = fakeGithub({ [`POST ${API}/repos/Upstream/app/forks`]: { status: 202, body: FORKED('Example-Org', 'app') } });
        const { account } = await open(gh);
        const fork = await account.forkRepo({ owner: 'Upstream', repo: 'app', into: 'Example-Org' });
        expect(fork).toMatchObject({ fullName: 'Example-Org/app', cloneUrl: 'https://github.com/Example-Org/app.git' });
        const post = gh.calls.find((c) => c.method === 'POST')!;
        expect(JSON.parse(post.body!)).toEqual({ organization: 'Example-Org', default_branch_only: false });
    });

    it('into the person themself: no `organization` (GitHub forks to the token’s user)', async () => {
        await signedIn();
        const gh = fakeGithub({ [`POST ${API}/repos/Upstream/app/forks`]: { status: 202, body: FORKED('ada', 'app') } });
        const { account } = await open(gh);
        await account.forkRepo({ owner: 'Upstream', repo: 'app', into: 'ADA' });
        expect(JSON.parse(gh.calls.find((c) => c.method === 'POST')!.body!)).toEqual({ default_branch_only: false });
    });

    it('a 403 forking into an account the App is not on: not-installed, with the install chooser for THAT account', async () => {
        await signedIn();
        const gh = fakeGithub({
            [`POST ${API}/repos/Upstream/app/forks`]: { status: 403, body: { message: 'Resource not accessible by integration' } },
            [`GET ${API}/users/Other-Org`]: { status: 200, body: { id: 4242, login: 'Other-Org' } },
        });
        const { account } = await open(gh);
        const error = await account.forkRepo({ owner: 'Upstream', repo: 'app', into: 'Other-Org' }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubNotInstalledError);
        expect((error as GithubNotInstalledError).account).toBe('Other-Org');
        expect((error as Error).message).toMatch(/suggested_target_id=4242/);
        expect((error as Error).message).toMatch(/Resource not accessible by integration/);
    });

    it('any other refusal is thrown in GitHub’s words', async () => {
        await signedIn();
        const { account } = await open(fakeGithub({ [`POST ${API}/repos/Upstream/app/forks`]: { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'Repository is empty' }] } } }));
        const error = await account.forkRepo({ owner: 'Upstream', repo: 'app', into: 'ada' }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubApiError);
        expect((error as Error).message).toBe('GitHub answered 422: Validation Failed — Repository is empty');
    });
});

describe('waiting for a fork to be ready (GitHub copies it asynchronously)', () => {
    const COMMITS = `GET ${API}/repos/Example-Org/app/commits?per_page=1`;

    it('polls until GitHub has its commits — 404 and 409 (empty) mean not yet — with growing waits', async () => {
        await signedIn();
        const gh = fakeGithub({ [COMMITS]: [{ status: 404, body: { message: 'Not Found' } }, { status: 409, body: { message: 'Git Repository is empty.' } }, { status: 409, body: { message: 'Git Repository is empty.' } }, { status: 200, body: [{ sha: 'abc' }] }] });
        const { account, sleeps } = await open(gh);
        await account.waitUntilReady('Example-Org/app');
        expect(gh.calls.filter((c) => c.url.endsWith('/commits?per_page=1'))).toHaveLength(4);
        // COUNTED: one wait before each retry, each longer than the one before.
        expect(sleeps).toHaveLength(3);
        expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
        expect(sleeps[2]!).toBeGreaterThan(sleeps[1]!);
    });

    it('ready at once: no wait at all', async () => {
        await signedIn();
        const { account, sleeps } = await open(fakeGithub({ [COMMITS]: { status: 200, body: [{ sha: 'abc' }] } }));
        await account.waitUntilReady('Example-Org/app');
        expect(sleeps).toEqual([]);
    });

    it('never ready: gives up after a bounded number of tries and total wait, and says so', async () => {
        await signedIn();
        const gh = fakeGithub({ [COMMITS]: { status: 409, body: { message: 'Git Repository is empty.' } } });
        const { account, sleeps } = await open(gh);
        const error = await account.waitUntilReady('Example-Org/app').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GithubApiError);
        expect((error as Error).message).toMatch(/Example-Org\/app/);
        expect((error as Error).message).toMatch(/not ready|has not finished/i);
        const tries = gh.calls.filter((c) => c.url.endsWith('/commits?per_page=1')).length;
        expect(tries).toBeGreaterThan(3);
        expect(tries).toBeLessThanOrEqual(20);
        expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
    });

    it('a refusal that is not "not yet" stops at once, in GitHub’s words', async () => {
        await signedIn();
        const gh = fakeGithub({ [COMMITS]: { status: 403, body: { message: 'Repository access blocked' } } });
        const { account, sleeps } = await open(gh);
        const error = await account.waitUntilReady('Example-Org/app').catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/GitHub answered 403: Repository access blocked/);
        expect(sleeps).toEqual([]);
    });
});

describe('the clone credential for an SSH URL (item 8)', () => {
    it('once GitHub is read, an SSH URL of an installed account clones over HTTPS with the sign-in', async () => {
        await signedIn();
        const gh = fakeGithub({
            [`GET ${API}/user/installations?per_page=100`]: { status: 200, body: { total_count: 1, installations: [installation(1, 'ada', false, 'all')] } },
            [`GET ${API}/user/installations/1/repositories?per_page=1`]: { status: 200, body: { total_count: 3, repositories: [] } },
        });
        const { account } = await open(gh);
        // Not read yet: nothing is claimed — the URL stays as the person gave it.
        expect(account.cloneAuth('git@github.com:ada/private.git')).toBeNull();
        await account.refresh();
        const auth = account.cloneAuth('git@github.com:ada/private.git');
        expect(auth?.url).toBe('https://github.com/ada/private.git');
        expect(auth?.secrets).toContain(TOKEN);
    });
});
