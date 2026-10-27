import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteChoice } from '../src/core/agi-remote.js';
import { buildPlan, startDraft, type SourceAnalysis } from '../src/core/envelope-plan.js';
import { GithubApiError, GithubNotInstalledError, GithubPermissionError, type CreatedRepo } from '../src/core/github.js';
import { publishEnvelope, type AgiRemotePorts } from '../src/main/agi-remote-host.js';
import { nodeEnvelopePorts } from '../src/main/envelope-fs.js';
import { buildEnvelope, readSource } from '../src/main/envelope-wizard-host.js';
import type { CreateRepoOptions } from '../src/main/github-account.js';
import { gitAddSubmodule, gitClone, gitPushMain, gitSetOrigin } from '../src/main/git-ports.js';
import { nodeWorkspaceFs } from '../src/main/workspace-fs.js';
import { createWorkspace, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * THE WORKSPACE'S OWN `<slug>.agi` REPOSITORY (Add workspace parity items 10 + 11; Genie 1's AddWorkspaceModal :401-471,
 * create-agi.ts pushEnvelopeToOrigin, InteractiveUpgradeWizard's None / GitHub / Paste URL). The owner, 2026-10-21:
 * "creating the repo in github is not required. users should be able to work off-grid if they need to with local models"
 * — so None is a first-class choice, and every failure past the envelope itself leaves the workspace made and registered,
 * with the step that failed named in the service's own words.
 *
 * Measured with the REAL git and the SAME git ports main.ts hands the ops, against a local BARE repository standing in for
 * the remote: GitHub is a fake whose `createRepo` answers that bare repo's path as the clone URL; Tynn is a fake session
 * that records each request. Nothing here reaches GitHub or Tynn. Git's global config is a file this test owns.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

let dir: string;
let parent: string;
let registered: Map<string, { id: string; path: string; asleep: boolean }>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-agi-remote-'));
    parent = join(dir, 'parent');
    await mkdir(parent);
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

/** An empty bare repository: what GitHub's `auto_init: false` repository is, before the first push. */
async function bare(name: string): Promise<string> {
    const at = join(dir, 'remotes', name);
    await mkdir(at, { recursive: true });
    await git(at, 'init', '--quiet', '--bare');
    return at;
}

interface Fakes {
    created: CreateRepoOptions[];
    tynnCalls: Array<{ path: string; method: string; body: unknown }>;
}

/**
 * The remote ports, as main.ts builds them, with the network faked: the real git ports (no credential — a local path
 * needs none), a GitHub whose createRepo answers `answer` (or throws it), a Tynn session answering `tynnAnswer`.
 */
function remotePorts(f: Fakes, opts: { createRepo?: (o: CreateRepoOptions) => Promise<CreatedRepo>; github?: 'signed-out'; tynn?: { signedIn: boolean; status?: number; json?: unknown } } = {}): AgiRemotePorts {
    return {
        git: { setOrigin: gitSetOrigin, pushMain: (path) => gitPushMain(path) },
        github: () => (opts.github === 'signed-out' ? null : {
            createRepo: async (o) => {
                f.created.push(o);
                if (!opts.createRepo) throw new Error('no GitHub in this test');
                return opts.createRepo(o);
            },
        }),
        tynn: {
            status: () => ({ signedIn: opts.tynn?.signedIn ?? true }),
            request: async (path, init) => {
                f.tynnCalls.push({ path, method: init.method, body: init.body });
                const status = opts.tynn?.status ?? 200;
                return { ok: status >= 200 && status < 300, status, json: async () => opts.tynn?.json ?? { project_id: 'p-1', is_envelope: true, envelope_status: 'present' } };
            },
        },
        readJson: async (p) => { try { return JSON.parse(await readFile(p, 'utf8')) as unknown; } catch { return null; } },
    };
}

const repoAt = (fullName: string, cloneUrl: string, created = true): CreatedRepo => ({ fullName, cloneUrl, htmlUrl: `https://github.com/${fullName}`, defaultBranch: 'main', private: true, created });

function ops(remote?: AgiRemotePorts): WorkspaceOpsPorts {
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
        sleep: async () => {},
        remote,
    };
}

const remotesOf = (ws: string) => git(ws, 'remote').then((r) => r.split('\n').filter(Boolean));
/** The commit `main` names in a bare repo, or `null` when it has no `main` (nothing was pushed). */
const bareMain = (at: string) => git(at, 'rev-parse', '--verify', '--quiet', 'refs/heads/main').catch(() => null);

describe('New workspace → GitHub: the repository is made, set as origin, and main is pushed to it', () => {
    it('creates <owner>/<slug>.agi (private), adds it as origin, and the bare remote holds exactly the local main', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const remote = await bare('acme-storefront.agi.git');
        const r = await createWorkspace(ops(remotePorts(f, { createRepo: async (o) => repoAt(`${o.owner}/${o.name}`, remote) })), 'Acme Storefront', parent, { kind: 'github', owner: 'acme-org', private: true });
        expect(r).toMatchObject({ ok: true, id: 'acme-storefront' });
        const ws = (r as { path: string }).path;

        expect(f.created).toEqual([expect.objectContaining({ owner: 'acme-org', name: 'acme-storefront.agi', private: true })]);
        expect(await remotesOf(ws)).toEqual(['origin']);
        expect(await git(ws, 'remote', 'get-url', 'origin')).toBe(remote);
        // The push landed on `main` there, and it is the same commit as here.
        expect(await bareMain(remote)).toBe(await git(ws, 'rev-parse', 'HEAD'));
        // `-u`: main tracks origin/main, so a later bare `git push` / `git pull` in the workspace just works (Genie 1).
        expect(await git(ws, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
        expect(registered.has('acme-storefront')).toBe(true);
        expect((r as { published?: unknown }).published).toMatchObject({ remote, pushed: true, problems: [], repo: { fullName: 'acme-org/acme-storefront.agi', created: true } });
    }, 60_000);

    it('a public choice asks GitHub for a public repository (the private toggle is what is sent)', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const remote = await bare('pub.agi.git');
        await createWorkspace(ops(remotePorts(f, { createRepo: async (o) => repoAt(`${o.owner}/${o.name}`, remote) })), 'pub', parent, { kind: 'github', owner: 'ada', private: false });
        expect(f.created.map((c) => c.private)).toEqual([false]);
    }, 60_000);
});

describe('Paste URL: the pasted remote becomes origin and main is pushed there — GitHub is never asked', () => {
    it('origin = the pasted URL, main lands on it, and no repository is created', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const remote = await bare('pasted.agi.git');
        const r = await createWorkspace(ops(remotePorts(f)), 'pasted', parent, { kind: 'paste', url: remote });
        expect(r).toMatchObject({ ok: true });
        const ws = (r as { path: string }).path;
        expect(await git(ws, 'remote', 'get-url', 'origin')).toBe(remote);
        expect(await bareMain(remote)).toBe(await git(ws, 'rev-parse', 'HEAD'));
        expect(f.created).toHaveLength(0);
    }, 60_000);
});

describe('None: off-grid is first-class — no remote, no GitHub, no Tynn', () => {
    it('leaves the workspace with NO remote (and the same probe reads `origin` where one was set)', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const r = await createWorkspace(ops(remotePorts(f, { createRepo: async () => { throw new Error('must not be called'); } })), 'offgrid', parent, { kind: 'none' });
        expect(r).toMatchObject({ ok: true, id: 'offgrid' });
        const ws = (r as { path: string }).path;
        expect(await remotesOf(ws)).toEqual([]);
        expect(f.created).toHaveLength(0);
        expect(f.tynnCalls).toHaveLength(0);
        expect(registered.has('offgrid')).toBe(true);
        // Still a real repository with its first commit: None is not a lesser workspace.
        expect(await git(ws, 'rev-list', '--count', 'HEAD')).toBe('1');

        // Positive control: the same probe on a workspace given a remote reads it.
        const remote = await bare('control.agi.git');
        const c = await createWorkspace(ops(remotePorts(f)), 'control', parent, { kind: 'paste', url: remote });
        expect(await remotesOf((c as { path: string }).path)).toEqual(['origin']);
    }, 60_000);

    it('no choice at all (an older caller) is None, and works with no remote ports wired', async () => {
        const r = await createWorkspace(ops(), 'plain', parent);
        expect(r).toMatchObject({ ok: true, id: 'plain' });
        expect(await remotesOf((r as { path: string }).path)).toEqual([]);
    }, 60_000);
});

describe('partial success: the workspace exists and is registered whatever GitHub, git or Tynn say', () => {
    it('GitHub refuses for a missing Administration grant: the problem names the installation to approve it on — not an install', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const refused = new GithubPermissionError('acme-org', 22, 'https://github.com/organizations/acme-org/settings/installations/22');
        const r = await createWorkspace(ops(remotePorts(f, { createRepo: async () => { throw refused; } })), 'perm', parent, { kind: 'github', owner: 'acme-org', private: true });
        expect(r).toMatchObject({ ok: true, id: 'perm' });
        const published = (r as unknown as { published: { problems: Array<{ step: string; message: string; account?: string; approve?: { installationId: number } }> } }).published;
        expect(published.problems).toHaveLength(1);
        expect(published.problems[0]).toMatchObject({ step: 'github', approve: { installationId: 22 } });
        expect(published.problems[0]!.account).toBeUndefined();
        expect(published.problems[0]!.message).toContain('Administration (Read and write)');
    }, 60_000);

    it('GitHub refuses (not installed): no remote, registered, and the problem is GitHub’s step in GitHub’s words', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const refused = new GithubNotInstalledError('acme-org', 'https://github.com/apps/genie-aos/installations/new?suggested_target_id=42', 404, 'GitHub answered 404: Not Found');
        const r = await createWorkspace(ops(remotePorts(f, { createRepo: async () => { throw refused; } })), 'half', parent, { kind: 'github', owner: 'acme-org', private: true });
        expect(r).toMatchObject({ ok: true, id: 'half' });
        expect(registered.has('half')).toBe(true);
        const ws = (r as { path: string }).path;
        expect(await remotesOf(ws)).toEqual([]);
        const published = (r as unknown as { published: { problems: Array<{ step: string; message: string; account?: string }>; pushed: boolean } }).published;
        expect(published.pushed).toBe(false);
        expect(published.problems).toHaveLength(1);
        expect(published.problems[0]).toMatchObject({ step: 'github', account: 'acme-org' });
        expect(published.problems[0]!.message).toContain('GitHub answered 404: Not Found');
        expect(published.problems[0]!.message).toContain('acme-org/half.agi');
    }, 60_000);

    it('GitHub answers another error: its words, and nothing after it runs', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const r = await createWorkspace(ops(remotePorts(f, { createRepo: async () => { throw new GithubApiError(422, 'GitHub answered 422: Repository creation failed. — name is too long'); } })), 'long', parent, { kind: 'github', owner: 'ada', private: true });
        const published = (r as unknown as { published: { problems: Array<{ step: string; message: string }> } }).published;
        expect(published.problems.map((p) => p.step)).toEqual(['github']);
        expect(published.problems[0]!.message).toContain('name is too long');
    }, 60_000);

    it('signed out of GitHub with GitHub chosen: the workspace is made, and the problem says to sign in', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const r = await createWorkspace(ops(remotePorts(f, { github: 'signed-out' })), 'nosign', parent, { kind: 'github', owner: 'ada', private: true });
        expect(r).toMatchObject({ ok: true });
        const published = (r as unknown as { published: { problems: Array<{ step: string; message: string }> } }).published;
        expect(published.problems.map((p) => p.step)).toEqual(['github']);
        expect(published.problems[0]!.message).toMatch(/sign in to GitHub/i);
    }, 60_000);

    it('the push fails: origin is still set (a later push works), registered, and the problem is git’s own words', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const nowhere = join(dir, 'remotes', 'does-not-exist.agi.git');
        const r = await createWorkspace(ops(remotePorts(f)), 'nopush', parent, { kind: 'paste', url: nowhere });
        expect(r).toMatchObject({ ok: true, id: 'nopush' });
        expect(registered.has('nopush')).toBe(true);
        const ws = (r as { path: string }).path;
        expect(await git(ws, 'remote', 'get-url', 'origin')).toBe(nowhere);
        const published = (r as unknown as { published: { problems: Array<{ step: string; message: string }>; pushed: boolean } }).published;
        expect(published.pushed).toBe(false);
        expect(published.problems.map((p) => p.step)).toEqual(['push']);
        // git's own stderr, not a bare exit code — read with the URL taken out, so the URL in Genie's sentence cannot pass it.
        expect(published.problems[0]!.message.split(nowhere).join('<url>')).toMatch(/fatal:|does not appear to be a git repository|Could not read from remote/i);
    }, 60_000);
});

/** An envelope linked to a Tynn project (project.json `tynn`), as the Tynn import and item 5's link write it. */
async function linkedEnvelope(name: string, projectId: string | null): Promise<string> {
    const r = await createWorkspace(ops(), name, parent, { kind: 'none' });
    const ws = (r as { path: string }).path;
    if (projectId) {
        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as Record<string, unknown>;
        await writeFile(join(ws, 'project.json'), JSON.stringify({ ...manifest, tynn: { host: 'https://tynn.example', project: name, projectId } }, null, 2));
        await git(ws, 'commit', '--quiet', '-am', 'link');
    }
    return ws;
}

describe('Tynn: declare-envelope is called exactly when the workspace is linked, with the .agi URL', () => {
    it('linked + a remote: ONE POST to declare-envelope with the project id and the URL; unlinked: none (counted, same fake)', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const linked = await linkedEnvelope('linked', 'proj-123');
        const remote = await bare('linked.agi.git');
        const p = await publishEnvelope(remotePorts(f), { path: linked, name: 'linked' }, { kind: 'paste', url: remote });
        expect(f.tynnCalls).toEqual([{ path: '/api/v1/projects/declare-envelope', method: 'POST', body: { project_id: 'proj-123', envelope_repository_url: remote } }]);
        expect(p).toMatchObject({ tynn: 'declared', problems: [], pushed: true });

        // The unlinked workspace, through the same fake: no call at all.
        const g: Fakes = { created: [], tynnCalls: [] };
        const unlinked = await linkedEnvelope('unlinked', null);
        const remote2 = await bare('unlinked.agi.git');
        const q = await publishEnvelope(remotePorts(g), { path: unlinked, name: 'unlinked' }, { kind: 'paste', url: remote2 });
        expect(g.tynnCalls).toHaveLength(0);
        expect(q).toMatchObject({ tynn: 'not-linked', problems: [] });
    }, 60_000);

    it('linked but None: nothing to declare, so no call (declare-envelope without a URL registers nothing)', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const ws = await linkedEnvelope('linkednone', 'proj-9');
        const p = await publishEnvelope(remotePorts(f), { path: ws, name: 'linkednone' }, { kind: 'none' });
        expect(f.tynnCalls).toHaveLength(0);
        expect(p).toMatchObject({ remote: null, tynn: 'no-remote', problems: [] });
    }, 60_000);

    it('linked + GitHub: the URL declared is the one GitHub created', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const ws = await linkedEnvelope('gh', 'proj-7');
        const remote = await bare('gh.agi.git');
        await publishEnvelope(remotePorts(f, { createRepo: async (o) => repoAt(`${o.owner}/${o.name}`, remote) }), { path: ws, name: 'gh' }, { kind: 'github', owner: 'ada', private: true });
        expect(f.tynnCalls.map((c) => (c.body as { envelope_repository_url: string }).envelope_repository_url)).toEqual([remote]);
    }, 60_000);

    it('the push failed but the repository exists: it is still declared (the URL is real), and only the push is a problem', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const ws = await linkedEnvelope('pushfail', 'proj-5');
        const nowhere = join(dir, 'remotes', 'missing.agi.git');
        const p = await publishEnvelope(remotePorts(f), { path: ws, name: 'pushfail' }, { kind: 'paste', url: nowhere });
        expect(f.tynnCalls).toHaveLength(1);
        expect(p.problems.map((x) => x.step)).toEqual(['push']);
    }, 60_000);

    it('Tynn refuses (422): the remote and push stand, and the problem is Tynn’s step in Tynn’s words', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const ws = await linkedEnvelope('refused', 'proj-4');
        const remote = await bare('refused.agi.git');
        const words = 'The envelope repository URL must be an .agi container remote (e.g. https://github.com/owner/workspace.agi).';
        const p = await publishEnvelope(remotePorts(f, { tynn: { signedIn: true, status: 422, json: { message: words, errors: { envelope_repository_url: [words] } } } }), { path: ws, name: 'refused' }, { kind: 'paste', url: remote });
        expect(p.pushed).toBe(true);
        expect(p.tynn).toBe('failed');
        expect(p.problems).toHaveLength(1);
        expect(p.problems[0]).toMatchObject({ step: 'tynn' });
        expect(p.problems[0]!.message).toContain(words);
    }, 60_000);

    it('Tynn refuses (403 forbidden): its error code is in the words', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const ws = await linkedEnvelope('forbid', 'proj-3');
        const remote = await bare('forbid.agi.git');
        const p = await publishEnvelope(remotePorts(f, { tynn: { signedIn: true, status: 403, json: { error: 'forbidden' } } }), { path: ws, name: 'forbid' }, { kind: 'paste', url: remote });
        expect(p.problems[0]!.message).toMatch(/403/);
        expect(p.problems[0]!.message).toContain('forbidden');
    }, 60_000);

    it('linked but signed out of Tynn: no request, and the problem says to sign in to Tynn', async () => {
        const f: Fakes = { created: [], tynnCalls: [] };
        const ws = await linkedEnvelope('signedout', 'proj-2');
        const remote = await bare('signedout.agi.git');
        const p = await publishEnvelope(remotePorts(f, { tynn: { signedIn: false } }), { path: ws, name: 'signedout' }, { kind: 'paste', url: remote });
        expect(f.tynnCalls).toHaveLength(0);
        expect(p.problems.map((x) => x.step)).toEqual(['tynn']);
        expect(p.problems[0]!.message).toMatch(/sign in to Tynn/i);
    }, 60_000);
});

describe('the wizard: a NEW envelope built around the person’s repo goes to its remote with both commits', () => {
    it('Workspace step → Paste URL: origin set, and the bare remote’s main is the convert commit on top of the first', async () => {
        const src = join(dir, 'src', 'acme-app');
        await mkdir(src, { recursive: true });
        await git(src, 'init', '--quiet', '--initial-branch=main');
        await writeFile(join(src, 'README.md'), '# Acme\n');
        await git(src, 'add', '--all');
        await git(src, 'commit', '--quiet', '-m', 'first');
        const env = nodeEnvelopePorts({ stagingBase: join(dir, 'staging') });
        await mkdir(join(dir, 'staging'));
        const read = await readSource(ops(), env, src);
        const analysis = (read as { analysis: SourceAnalysis }).analysis;
        const draft = startDraft(analysis, { parent });
        const plan = buildPlan({ ...draft, repos: draft.repos.map((r) => ({ ...r, source: 'local' as const })) });
        const f: Fakes = { created: [], tynnCalls: [] };
        const remote = await bare('acme-app.agi.git');
        const choice: RemoteChoice = { kind: 'paste', url: remote };
        const built = await buildEnvelope(ops(remotePorts(f)), env, plan, choice);
        expect(built).toMatchObject({ ok: true });
        const ws = (built as { path: string }).path;
        expect(await git(ws, 'remote', 'get-url', 'origin')).toBe(remote);
        expect(await bareMain(remote)).toBe(await git(ws, 'rev-parse', 'HEAD'));
        expect(await git(remote, 'rev-list', '--count', 'main')).toBe('2');
        expect((built as { published?: { problems: unknown[] } }).published?.problems).toEqual([]);
    }, 60_000);

    it('Workspace step → None: no remote on the built envelope', async () => {
        const src = join(dir, 'src', 'notes');
        await mkdir(src, { recursive: true });
        await writeFile(join(src, 'plan.md'), 'plan\n');
        const env = nodeEnvelopePorts({ stagingBase: join(dir, 'staging') });
        await mkdir(join(dir, 'staging'));
        const read = await readSource(ops(), env, src);
        const plan = buildPlan(startDraft((read as { analysis: SourceAnalysis }).analysis, { parent }));
        const f: Fakes = { created: [], tynnCalls: [] };
        const built = await buildEnvelope(ops(remotePorts(f)), env, plan, { kind: 'none' });
        expect(built).toMatchObject({ ok: true });
        expect(await remotesOf((built as { path: string }).path)).toEqual([]);
        expect(f.created).toHaveLength(0);
    }, 60_000);
});
