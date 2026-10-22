import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvelopePlan } from '../src/core/envelope-plan.js';
import { GithubApiError, type CreatedRepo } from '../src/core/github.js';
import { nodeEnvelopePorts } from '../src/main/envelope-fs.js';
import { buildEnvelope, type EnvelopePorts } from '../src/main/envelope-wizard-host.js';
import { gitAddSubmodule, gitClone } from '../src/main/git-ports.js';
import { nodeWorkspaceFs } from '../src/main/workspace-fs.js';
import type { WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * FORK EACH REPO INTO THE CHOSEN OWNER (Add workspace parity item 12) and SSH → HTTPS for a clone (item 8) — measured with
 * the REAL git.
 *
 * Genie 1 (InteractiveUpgradeWizard.tsx:605-632) forked every repository set to Fork FIRST, then built the envelope with
 * each fork's clone URL as the submodule. Here GitHub is a fake whose "fork" is a local bare repository (a clone of the
 * upstream one), so the submodule really is cloned from what GitHub handed back; GitHub is never reached. The fork must be
 * READY (waited for) before git clones it, and a fork GitHub refuses stops everything before a single file is written.
 */

const run = promisify(execFile);
/**
 * REAL GIT HAS ITS OWN BUDGET (beta.37's Windows release job, 2026-10-22: "each repo forked…" ran past vitest's 5 s
 * default at 5019 ms — about twenty real git processes, and a process start costs far more on Windows). The other
 * real-git suites carry the same kind of budget (create-workspace-first-commit, envelope-build). The fork wait itself
 * never sleeps here (`sleep` is injected as a no-op), so this is git's time, not a hidden wait.
 */
const REAL_GIT_MS = 120_000;

const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

let dir: string;
let parent: string;
let remotes: string;
let registered: Map<string, { id: string; path: string; asleep: boolean; envFile?: string }>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-fork-build-'));
    parent = join(dir, 'parent');
    remotes = join(dir, 'remotes');
    for (const d of [parent, remotes]) await mkdir(d);
    const globalConfig = join(dir, 'global.gitconfig');
    await writeFile(globalConfig, '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n[init]\n\tdefaultBranch = main\n');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    for (const k of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) vi.stubEnv(k, undefined);
    registered = new Map();
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
});

function ops(): WorkspaceOpsPorts {
    return {
        fs: { ...nodeWorkspaceFs(), gitClone: (url, into, branch) => gitClone(url, into, undefined, branch), gitAddSubmodule: (envelope, url, at, branch, local) => gitAddSubmodule(envelope, url, at, branch, undefined, local) },
        registry: {
            workspace: (id) => registered.get(id) ?? null,
            list: () => [...registered.values()],
            addWorkspace: async (w) => { registered.set(w.id, { ...w, asleep: false }); },
            agentsOf: () => [],
            setAsleep: async () => false,
            forgetWorkspace: async () => null,
        },
        host: { probe: () => null, prompt: () => false, stop: () => false },
        attention: { finished: () => [] },
        terminals: { list: () => [], close: () => false },
        supervisor: { list: () => [], stop: () => false },
        now: () => Date.now(),
        defaultEnvFile: () => '.env',
        sleep: async () => {},
    };
}

/** A bare repository with one commit on main: GitHub's copy of a repository, as a folder. */
async function bareRepo(name: string, file: string): Promise<string> {
    const work = join(dir, `work-${name}`);
    await mkdir(work, { recursive: true });
    await git(work, 'init', '--quiet', '--initial-branch=main');
    await writeFile(join(work, file), `${name}\n`);
    await git(work, 'add', '--all');
    await git(work, 'commit', '--quiet', '-m', 'first');
    const bare = join(remotes, `${name}.git`);
    await git(dir, 'clone', '--quiet', '--bare', work, bare);
    return bare;
}

/** GitHub, faked: a fork is a bare clone made at fork time; `ready` is recorded so the order can be checked. */
function fakeForks(opts: { refuse?: string } = {}) {
    const events: string[] = [];
    const port = {
        async forkRepo(o: { owner: string; repo: string; into: string }): Promise<CreatedRepo> {
            events.push(`fork ${o.owner}/${o.repo} -> ${o.into}`);
            if (opts.refuse === o.repo) throw new GithubApiError(403, 'GitHub answered 403: Resource not accessible by integration');
            const upstream = join(remotes, `${o.repo}.git`);
            const fork = join(remotes, `${o.into}-${o.repo}-fork.git`);
            await git(dir, 'clone', '--quiet', '--bare', upstream, fork);
            return { fullName: `${o.into}/${o.repo}`, cloneUrl: fork, htmlUrl: `https://github.com/${o.into}/${o.repo}`, defaultBranch: 'main', private: true, created: true };
        },
        async waitUntilReady(fullName: string): Promise<void> {
            events.push(`ready ${fullName}`);
        },
    };
    return { events, port };
}

const envWith = (github: EnvelopePorts['github']): EnvelopePorts => ({ ...nodeEnvelopePorts({ stagingBase: join(dir, 'staging') }), github });

function plan(over: Partial<EnvelopePlan> = {}): EnvelopePlan {
    return {
        name: 'forked', parent, source: join(dir, 'source'), staged: false,
        repos: [
            { name: 'app', url: 'https://github.com/Upstream/app.git', local: false, fork: { owner: 'Upstream', repo: 'app' } },
            { name: 'lib', url: 'git@github.com:Upstream/lib.git', local: false, fork: { owner: 'Upstream', repo: 'lib' } },
        ],
        knowledge: [], primary: null, forkInto: 'Example-Org',
        ...over,
    };
}

describe('Fork: the forks are made and READY before the envelope is built, and the forks become the submodules', () => {
    it('each repo forked into the chosen owner, waited for, then added FROM THE FORK (.gitmodules and project.json say so)', async () => {
        await bareRepo('app', 'app.txt');
        await bareRepo('lib', 'lib.txt');
        const gh = fakeForks();
        const b = await buildEnvelope(ops(), envWith(() => gh.port), plan());
        expect(b).toMatchObject({ ok: true });
        if (!b.ok) return;
        // Forked and waited for, each, before git touched it.
        expect(gh.events).toEqual(['fork Upstream/app -> Example-Org', 'ready Example-Org/app', 'fork Upstream/lib -> Example-Org', 'ready Example-Org/lib']);
        const appFork = join(remotes, 'Example-Org-app-fork.git');
        const libFork = join(remotes, 'Example-Org-lib-fork.git');
        expect(await git(b.path, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/app.url')).toBe(appFork);
        expect(await git(b.path, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/lib.url')).toBe(libFork);
        // The submodules really were cloned from the forks: the upstream's files are there.
        expect((await readFile(join(b.path, 'repos', 'app', 'app.txt'), 'utf8')).trim()).toBe('app');
        expect((await readFile(join(b.path, 'repos', 'lib', 'lib.txt'), 'utf8')).trim()).toBe('lib');
        const manifest = JSON.parse(await readFile(join(b.path, 'project.json'), 'utf8')) as { repos: Array<{ name: string; url: string }> };
        expect(manifest.repos.map((r) => [r.name, r.url])).toEqual([['app', appFork], ['lib', libFork]]);
        expect(registered.size).toBe(1);
    }, REAL_GIT_MS);

    it('a fork GitHub refuses: NOTHING is built — no folder, nothing registered — said in GitHub’s words, naming the fork already made', async () => {
        await bareRepo('app', 'app.txt');
        await bareRepo('lib', 'lib.txt');
        const gh = fakeForks({ refuse: 'lib' });
        const b = await buildEnvelope(ops(), envWith(() => gh.port), plan());
        expect(b.ok).toBe(false);
        const reason = b.ok ? '' : b.reason;
        expect(reason).toMatch(/Upstream\/lib/);
        expect(reason).toMatch(/Example-Org/);
        expect(reason).toMatch(/Resource not accessible by integration/);
        // The fork that WAS made is named: it stays on GitHub, and a retry finds it (GitHub hands an existing fork back).
        expect(reason).toMatch(/Example-Org\/app/);
        expect(await readdir(parent)).toEqual([]);
        expect(registered.size).toBe(0);
    }, REAL_GIT_MS);

    it('not signed in to GitHub: refused before anything is written or forked', async () => {
        const b = await buildEnvelope(ops(), envWith(() => null), plan());
        expect(b.ok).toBe(false);
        expect(b.ok ? '' : b.reason).toMatch(/sign in to GitHub/i);
        expect(await readdir(parent)).toEqual([]);
    }, REAL_GIT_MS);

    it('positive control: a plan with NO fork row never asks GitHub, signed in or not', async () => {
        const bare = await bareRepo('app', 'app.txt');
        const gh = fakeForks();
        const b = await buildEnvelope(ops(), envWith(() => gh.port), plan({ repos: [{ name: 'app', url: bare, local: false }], forkInto: null }));
        expect(b).toMatchObject({ ok: true });
        expect(gh.events).toEqual([]);
        const unsigned = await buildEnvelope(ops(), envWith(() => null), plan({ name: 'second', repos: [{ name: 'app', url: bare, local: false }], forkInto: null }));
        expect(unsigned).toMatchObject({ ok: true });
    }, REAL_GIT_MS);
});

describe('SSH → HTTPS for a clone (item 8): the credential’s URL is what git fetches', () => {
    it('gitClone fetches from the auth’s URL when it carries one — the URL the person gave is never contacted', async () => {
        const bare = await bareRepo('private', 'secret.txt');
        const into = join(dir, 'clone');
        // If git tried the SSH URL it would fail at once (ssh is replaced by `false`, so nothing can hang on a prompt).
        vi.stubEnv('GIT_SSH_COMMAND', 'false');
        await gitClone('git@github.com:ada/private.git', into, { url: bare, config: [], secrets: [] });
        expect((await readFile(join(into, 'secret.txt'), 'utf8')).trim()).toBe('private');
        expect(await git(into, 'remote', 'get-url', 'origin')).toBe(bare);
    }, REAL_GIT_MS);

    it('positive control: with no URL in the auth, the given URL is the one cloned', async () => {
        const bare = await bareRepo('plain', 'plain.txt');
        const into = join(dir, 'clone2');
        await gitClone(bare, into, { config: [], secrets: [] });
        expect(await git(into, 'remote', 'get-url', 'origin')).toBe(bare);
    }, REAL_GIT_MS);
});
