import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { GithubAccount, githubSealedSources, type GithubAccountPorts } from '../src/main/github-account.js';
import { GithubAccountService, type GithubGitPorts } from '../src/main/github-account-service.js';
import { migrateSecrets, type HostVault, type MigrationBook, type MigrationState } from '../src/main/keychain-migration.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/**
 * GITHUB'S ACCOUNT IS THE HOST'S, AND ITS TOKENS NEVER CROSS TO THE WINDOW (P3.4 cut c; plan §13). They are in the keychain as `github/access` and
 * `github/refresh`, the file says who is signed in and holds no token, and a window reads a replica and asks the host to act. Authenticated git runs in the
 * host too: a window asks for a clone or a push and hears the outcome. There is no call that returns a token, and no fallback that passes one over the link.
 */

const TOKEN = 'ghu_exampletoken0000000000000000000000';
const REFRESH = 'ghr_examplerefresh00000000000000000000';
const NEW_TOKEN = 'ghu_freshtoken11111111111111111111111';
const NEW_REFRESH = 'ghr_freshrefresh111111111111111111111';
const NOW = Date.UTC(2026, 10, 2);
const SECRETS = [TOKEN, REFRESH, NEW_TOKEN, NEW_REFRESH];

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'github-host-')); file = join(dir, 'github.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

type Lockable = ReturnType<typeof fakeKeychain> & { locked: boolean; setFails: boolean };
function keychain(seed: Record<string, string> = {}): Lockable {
    const base = fakeKeychain(seed);
    const k: Lockable = {
        ...base, locked: false, setFails: false,
        probe: async () => (k.locked ? { ok: false as const, reason: 'locked' } : { ok: true as const }) as never,
        get: async (name: string) => (k.locked ? { kind: 'unavailable' as const, reason: 'locked' } : base.get(name)) as never,
        set: async (name: string, value: string) => (k.locked || k.setFails ? { ok: false as const, reason: 'locked' } : base.set(name, value)) as never,
        delete: async (name: string) => (k.locked ? { ok: false as const, reason: 'locked' } : base.delete(name)) as never,
    };
    return k;
}

function fakeGithub() {
    const gh = {
        calls: [] as string[], polls: [] as Array<Record<string, unknown>>, accepts: new Set([TOKEN, NEW_TOKEN]),
        fetch: (async (url, init) => {
            gh.calls.push(url);
            const answer = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
            if (url === 'https://github.com/login/device/code') return answer(200, { device_code: 'dev-1', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 });
            if (url === 'https://github.com/login/oauth/access_token') {
                if (init.body?.includes('grant_type=refresh_token')) return answer(200, { access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 28800, refresh_token_expires_in: 15811200, token_type: 'bearer' });
                return answer(200, gh.polls.shift() ?? { error: 'authorization_pending' });
            }
            const token = init.headers.Authorization?.replace(/^Bearer /, '') ?? '';
            if (!gh.accepts.has(token)) return answer(401, { message: 'Bad credentials' });
            if (url === 'https://api.github.com/user') return answer(200, { login: 'ada', name: 'Ada' });
            if (url === 'https://api.github.com/user/installations?per_page=100') return answer(200, { total_count: 1, installations: [{ id: 11, account: { login: 'ada', type: 'User' }, repository_selection: 'all', permissions: { metadata: 'read', contents: 'write' } }] });
            if (url.startsWith('https://api.github.com/user/installations/11/repositories')) return answer(200, { total_count: 1, repositories: [{ full_name: 'ada/one' }] });
            return answer(404, { message: 'Not Found' });
        }) as GithubAccountPorts['fetch'],
    };
    return gh;
}
const portsWith = (k: Lockable, gh: ReturnType<typeof fakeGithub>): GithubAccountPorts => ({
    file, secrets: k, fetch: gh.fetch, now: () => NOW,
    sleep: async () => {},
});
const record = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, state: 'signed-in', login: 'ada', name: 'Ada', source: 'sign-in', ...over });

describe('the tokens are in the keychain', () => {
    it('a sign-in puts both there, and the file holds who it is and no token, sealed or not', async () => {
        const k = keychain();
        const gh = fakeGithub();
        gh.polls.push({ access_token: TOKEN, refresh_token: REFRESH, expires_in: 28800, refresh_token_expires_in: 15811200, token_type: 'bearer' });
        const account = await GithubAccount.open(portsWith(k, gh));
        await account.startSignIn();
        await account.signInSettled();
        expect(account.view()).toMatchObject({ status: 'signed-in', user: { login: 'ada' } });
        expect(k.held.get('github/access')).toBe(TOKEN);
        expect(k.held.get('github/refresh')).toBe(REFRESH);
        const text = readFileSync(file, 'utf8');
        for (const secret of SECRETS) expect(text).not.toContain(secret);
        expect(JSON.parse(text).tokenEnc).toBeUndefined();
        expect(JSON.parse(text).refreshEnc).toBeUndefined();
        expect(JSON.parse(text)).toMatchObject({ state: 'signed-in', login: 'ada', accessExpiresAt: NOW + 28_800_000 });
    });

    it('a new launch restores them', async () => {
        writeFileSync(file, record());
        const account = await GithubAccount.open(portsWith(keychain({ 'github/access': TOKEN }), fakeGithub()));
        expect(account.view().status).toBe('signed-in');
    });

    it('a renewal replaces both in the keychain', async () => {
        writeFileSync(file, record({ accessExpiresAt: NOW - 1, refreshExpiresAt: NOW + 1e9 }));
        const k = keychain({ 'github/access': TOKEN, 'github/refresh': REFRESH });
        const gh = fakeGithub();
        gh.accepts.delete(TOKEN);
        const account = await GithubAccount.open(portsWith(k, gh));
        await account.refresh();
        expect(k.held.get('github/access')).toBe(NEW_TOKEN);
        expect(k.held.get('github/refresh')).toBe(NEW_REFRESH);
        expect(readFileSync(file, 'utf8')).not.toContain(NEW_TOKEN);
    });

    it('a sign-out removes both, and says so on disk', async () => {
        writeFileSync(file, record());
        const k = keychain({ 'github/access': TOKEN, 'github/refresh': REFRESH });
        const account = await GithubAccount.open(portsWith(k, fakeGithub()));
        await account.signOut();
        expect(k.held.has('github/access')).toBe(false);
        expect(k.held.has('github/refresh')).toBe(false);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, state: 'signed-out' });
    });

    it('no keychain: a sign-in is refused BEFORE GitHub is asked, so no token is minted that could not be kept', async () => {
        const k = keychain();
        k.locked = true;
        const gh = fakeGithub();
        const account = await GithubAccount.open(portsWith(k, gh));
        await account.startSignIn();
        expect(gh.calls).toEqual([]);
        expect(account.view().message).toMatch(/keyring|keychain/i);
    });

    it('a keychain that takes nothing as the sign-in lands: not signed in, and said', async () => {
        const k = keychain();
        k.setFails = true;
        const gh = fakeGithub();
        gh.polls.push({ access_token: TOKEN, token_type: 'bearer' });
        const account = await GithubAccount.open(portsWith(k, gh));
        await account.startSignIn();
        await account.signInSettled();
        expect(account.view().status).not.toBe('signed-in');
        expect(existsSync(file)).toBe(false);
    });
});

describe('a locked keychain is never read as signed out', () => {
    it('the record stands, the entries stand, it says why, and a reload signs in with no device flow', async () => {
        writeFileSync(file, record());
        const before = readFileSync(file, 'utf8');
        const k = keychain({ 'github/access': TOKEN });
        k.locked = true;
        const gh = fakeGithub();
        const account = await GithubAccount.open(portsWith(k, gh));
        expect(account.view()).toMatchObject({ status: 'expired', user: { login: 'ada' }, message: expect.stringMatching(/keyring|keychain/i) });
        expect(readFileSync(file, 'utf8')).toBe(before);
        expect(k.held.get('github/access')).toBe(TOKEN);
        k.locked = false;
        await account.reload();
        expect(account.view().status).toBe('signed-in');
        expect(gh.calls.filter((c) => c.includes('/login/device'))).toEqual([]);
    });

    it('CONTROL: an entry that is really gone needs a sign-in, in words, and a reload changes nothing', async () => {
        writeFileSync(file, record());
        const account = await GithubAccount.open(portsWith(keychain(), fakeGithub()));
        expect(account.view()).toMatchObject({ status: 'expired', user: { login: 'ada' }, message: expect.stringMatching(/sign in again/i) });
        await account.reload();
        expect(account.view().status).toBe('expired');
    });
});

describe('git runs in the host: a window asks, and hears the outcome', () => {
    function gitFake() {
        const calls: Array<{ op: string; args: unknown[]; auth: unknown }> = [];
        let fail: string | null = null;
        const git: GithubGitPorts = {
            clone: async (url, into, auth, branch) => { calls.push({ op: 'clone', args: [url, into, branch], auth }); if (fail) throw new Error(fail); },
            addSubmodule: async (envelope, url, at, branch, auth, local) => { calls.push({ op: 'addSubmodule', args: [envelope, url, at, branch, local], auth }); if (fail) throw new Error(fail); return 'main'; },
            pushMain: async (path, auth) => { calls.push({ op: 'pushMain', args: [path], auth }); if (fail) throw new Error(fail); },
        };
        return { git, calls, failWith: (text: string) => { fail = text; } };
    }
    async function linked(fake = gitFake()) {
        writeFileSync(file, record());
        const account = await GithubAccount.open(portsWith(keychain({ 'github/access': TOKEN }), fakeGithub()));
        await account.refresh();
        const service = new GithubAccountService(account, { git: fake.git });
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test', github: service });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const seen: string[] = [];
        windowSide.onMessage((line: string) => seen.push(line));
        const client = new SessionEngineClient();
        await client.connect(windowSide, 'a'.repeat(64));
        return { account, service, client, replica: client.github(), seen, ...fake };
    }

    it('a clone of a repository the App can read: the host carries the credential', async () => {
        const { replica, calls } = await linked();
        await replica.gitClone('https://github.com/ada/one.git', '/work/one', 'main');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ op: 'clone', args: ['https://github.com/ada/one.git', '/work/one', 'main'] });
        expect(JSON.stringify(calls[0]!.auth)).toContain(TOKEN);
    });

    it('a submodule and a push, the same way', async () => {
        const { replica, calls } = await linked();
        expect(await replica.gitAddSubmodule('/env', 'https://github.com/ada/one.git', 'repos/one', null, false)).toBe('main');
        await replica.gitPushMain('/work/one', 'https://github.com/ada/one.git');
        expect(calls.map((c) => c.op)).toEqual(['addSubmodule', 'pushMain']);
        for (const call of calls) expect(JSON.stringify(call.auth)).toContain(TOKEN);
    });

    it('a repository the App does not reach: no credential, so the person’s own helper answers, as before', async () => {
        const { replica, calls } = await linked();
        await replica.gitClone('https://github.com/someone-else/x.git', '/work/x', null);
        expect(calls[0]!.auth).toBeUndefined();
    });

    it('git’s failure comes back in git’s words, and the host’s error is scrubbed by git-ports, not by the window', async () => {
        const fake = gitFake();
        fake.failWith('fatal: repository not found');
        const { replica } = await linked(fake);
        await expect(replica.gitClone('https://github.com/ada/one.git', '/work/one', null)).rejects.toThrow('fatal: repository not found');
    });

    it('NOTHING THE LINK CARRIES HOLDS A TOKEN: the dump, the view, each outcome; and CONTROL, the gauge reads the wire', async () => {
        const { replica, client, seen, service } = await linked();
        await replica.gitClone('https://github.com/ada/one.git', '/work/one', null);
        await replica.gitPushMain('/work/one', 'https://github.com/ada/one.git');
        await client.call('engine.github', ['refresh', []]);
        expect(JSON.stringify(service.dump())).not.toContain(TOKEN);
        const wire = seen.join('\n');
        expect(wire).toContain('ada');
        expect(wire).toContain('gitClone');
        for (const secret of SECRETS) expect(wire).not.toContain(secret);
    });

    it.each(['cloneAuth', 'pushAuth', 'token', 'credential'])('no method a window can ask for returns a credential: %s', async (method) => {
        const { client } = await linked();
        const asked = await client.call('engine.github', [method, ['https://github.com/ada/one.git']]);
        expect(asked.ok).toBe(false);
        expect(JSON.stringify(asked)).not.toContain(TOKEN);
    });

    it('a real git, end to end through the default port: a local repository clones through the host', async () => {
        const source = join(dir, 'source');
        mkdirSync(source);
        const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
        git('init', '-q', '-b', 'main');
        writeFileSync(join(source, 'a.txt'), 'hello\n');
        git('add', 'a.txt');
        git('commit', '-q', '-m', 'one');
        writeFileSync(file, record());
        const account = await GithubAccount.open(portsWith(keychain({ 'github/access': TOKEN }), fakeGithub()));
        const service = new GithubAccountService(account);
        const into = join(dir, 'cloned');
        await service.call('gitClone', [source, into, null]);
        expect(readFileSync(join(into, 'a.txt'), 'utf8')).toBe('hello\n');
    });

    it('main.ts holds no credential and runs no authenticated git, with a host', () => {
        const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        const main = strip(readFileSync('src/main/main.ts', 'utf8'));
        expect(main).not.toMatch(/\.cloneAuth\(|\.pushAuth\(/);
        for (const file of ['src/main/github-account-replica.ts', 'src/main/session-engine-client.ts', 'src/main/session-engine-server.ts']) {
            expect(strip(readFileSync(file, 'utf8')), file).not.toMatch(/cloneAuth|pushAuth/);
        }
    });
});

describe('a window reads a replica', () => {
    async function linked(k = keychain({ 'github/access': TOKEN }), opened: string[] = []) {
        writeFileSync(file, record());
        const gh = fakeGithub();
        const account = await GithubAccount.open(portsWith(k, gh));
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test', github: new GithubAccountService(account) });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, 'a'.repeat(64));
        return { account, gh, client, replica: client.github({ openExternal: async (url) => { opened.push(url); } }), opened };
    }

    it('a window that connects to a signed-in host reads signed in at once, and hears a change', async () => {
        const { replica, account } = await linked();
        expect(replica.view()).toMatchObject({ status: 'signed-in', user: { login: 'ada' } });
        let changes = 0;
        replica.onChange(() => { changes += 1; });
        await account.signOut();
        for (let i = 0; i < 40 && replica.view().status === 'signed-in'; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(replica.view().status).toBe('signed-out');
        expect(changes).toBeGreaterThan(0);
    });

    it('a sign-in asked from the window opens the browser IN THE WINDOW: the host has none', async () => {
        const opened: string[] = [];
        writeFileSync(file, JSON.stringify({ version: 1, state: 'signed-out' }));
        const gh = fakeGithub();
        const account = await GithubAccount.open(portsWith(keychain(), gh));
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test', github: new GithubAccountService(account) });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, 'a'.repeat(64));
        const replica = client.github({ openExternal: async (url) => { opened.push(url); } });
        await replica.startSignIn();
        for (let i = 0; i < 40 && opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(opened).toEqual(['https://github.com/login/device']);
        replica.cancelSignIn();
    });

    it('a window opens only GitHub’s own pages, whatever the link says', async () => {
        const { client, opened } = await linked();
        client.github().openFromHost('https://elsewhere.example/phish');
        client.github().openFromHost('https://github.com/settings/installations');
        expect(opened).toEqual(['https://github.com/settings/installations']);
    });

    it('with no link it reads signed out, and git refuses', async () => {
        const replica = new SessionEngineClient().github();
        expect(replica.view().status).toBe('signed-out');
        await expect(replica.gitPushMain('/w', 'https://github.com/a/b.git')).rejects.toThrow();
    });
});

describe('what an older Genie sealed moves to the keychain', () => {
    const cipher = { decrypt: (bytes: Buffer) => { const text = bytes.toString(); if (!text.startsWith('sealed:')) throw new Error('another OS user'); return text.slice('sealed:'.length); } };
    const seal = (text: string) => Buffer.from(`sealed:${text}`).toString('base64');
    const memoryBook = (): MigrationBook => { const states: Record<string, MigrationState> = {}; return { read: async () => ({ ...states }), write: async (name, state) => { states[name] = state; } }; };
    const vaultOver = (k: Lockable): HostVault => ({ store: (name, value) => k.set(name, value) as never, compare: async (name, value) => (k.held.get(name) === value ? 'same' : 'different') });

    it('both tokens move; the file keeps who it is and the expiries; a reload signs in', async () => {
        writeFileSync(file, record({ tokenEnc: seal(TOKEN), refreshEnc: seal(REFRESH), accessExpiresAt: NOW + 1000 }));
        const k = keychain();
        const account = await GithubAccount.open(portsWith(k, fakeGithub()));
        expect(account.view().status).toBe('expired');
        const moved = await migrateSecrets(await githubSealedSources({ file, cipher }), vaultOver(k), memoryBook());
        expect(moved).toEqual([{ name: 'github/access', status: 'moved' }, { name: 'github/refresh', status: 'moved' }]);
        expect(k.held.get('github/access')).toBe(TOKEN);
        expect(k.held.get('github/refresh')).toBe(REFRESH);
        const after = JSON.parse(readFileSync(file, 'utf8'));
        expect(after.tokenEnc).toBeUndefined();
        expect(after.refreshEnc).toBeUndefined();
        expect(after).toMatchObject({ login: 'ada', accessExpiresAt: NOW + 1000 });
        await account.reload();
        expect(account.view().status).toBe('signed-in');
    });

    it('a seal that will not open is not moved and not deleted', async () => {
        writeFileSync(file, record({ tokenEnc: Buffer.from('other:x').toString('base64') }));
        const k = keychain();
        const moved = await migrateSecrets(await githubSealedSources({ file, cipher }), vaultOver(k), memoryBook());
        expect(moved[0]).toEqual({ name: 'github/access', status: 'old-copy-unreadable' });
        expect(JSON.parse(readFileSync(file, 'utf8')).tokenEnc).toBeDefined();
    });

    it('GENIE 1’S LOGIN carries over the same way, with no file yet: tokens moved, and the record says whose and from where', async () => {
        const v1Settings = () => ({ github_token_enc: seal(TOKEN), github_user: 'ada', github_refresh_enc: seal(REFRESH), github_token_exp_ms: String(NOW + 1000), github_refresh_exp_ms: String(NOW + 9000) });
        const k = keychain();
        const moved = await migrateSecrets(await githubSealedSources({ file, cipher, v1Settings }), vaultOver(k), memoryBook());
        expect(moved.map((m) => m.status)).toEqual(['moved', 'moved']);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ state: 'signed-in', login: 'ada', source: 'genie-1', accessExpiresAt: NOW + 1000, refreshExpiresAt: NOW + 9000 });
        const account = await GithubAccount.open(portsWith(k, fakeGithub()));
        expect(account.view()).toMatchObject({ status: 'signed-in', user: { login: 'ada' } });
    });

    it('this Genie’s own file wins; after a sign-out, Genie 1’s is NOT carried over again', async () => {
        writeFileSync(file, JSON.stringify({ version: 1, state: 'signed-out' }));
        const v1Settings = () => ({ github_token_enc: seal(TOKEN), github_user: 'ada' });
        expect(await githubSealedSources({ file, cipher, v1Settings })).toEqual([]);
    });

    it('nothing sealed, and no Genie 1: nothing to move', async () => {
        expect(await githubSealedSources({ file, cipher })).toEqual([]);
        writeFileSync(file, record());
        expect(await githubSealedSources({ file, cipher })).toEqual([]);
    });
});
