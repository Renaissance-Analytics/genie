import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addWorkspaceFromTynn, listTynnProjects, previewAddFromTynn, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';
import { nodeWorkspaceFs } from '../src/main/workspace-fs.js';
import { gitAddSubmodule, gitClone } from '../src/main/git-ports.js';

/**
 * IMPORT FROM TYNN BRINGS ITS CONTENT (Add workspace parity, item 3). Tynn's `GET /api/v1/projects` says what a project
 * contains — an `envelope` block naming its container (`envelope_status` 'present'), its `repositories[]`, or neither —
 * and Genie 1 brought that content down (main/workspace/add-workspace.ts): it cloned the envelope, or built one with the
 * repos as submodules, or made an empty one; and a project already here was opened, not cloned twice. Genie 2 parsed
 * none of it and always made an empty envelope.
 *
 * Measured with the REAL git and the same filesystem and git functions main.ts hands the workspace ops, in a temp folder.
 * Local bare repositories stand in for GitHub (file:// URLs); a fake Tynn client returns the row shape Tynn's projectRow()
 * was measured to send. Git's global config is a file this test owns (GIT_CONFIG_GLOBAL): an identity, and
 * `protocol.file.allow=always` so git will clone file:// submodules — the test's stand-in for https, never product code.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

let dir: string;
let parent: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-tynn-import-'));
    parent = join(dir, 'parent');
    await mkdir(parent);
    const globalConfig = join(dir, 'global.gitconfig');
    await writeFile(globalConfig, '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    for (const k of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) vi.stubEnv(k, undefined);
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
});

/** A bare repository with one commit per branch: `{ main: { 'README.md': '…' }, develop: { … } }` — each branch's files on top of main's. */
async function bareRepo(name: string, branches: Record<string, Record<string, string>>): Promise<string> {
    const bare = join(dir, 'remotes', `${name}.git`);
    const work = join(dir, 'work', name);
    await mkdir(join(dir, 'remotes'), { recursive: true });
    await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare]);
    await run('git', ['init', '--quiet', '--initial-branch=main', work]);
    for (const [branch, files] of Object.entries(branches)) {
        if (branch !== 'main') await git(work, 'checkout', '--quiet', '-B', branch, 'main');
        for (const [file, text] of Object.entries(files)) {
            await mkdir(join(work, file, '..'), { recursive: true });
            await writeFile(join(work, file), text);
        }
        await git(work, 'add', '--all');
        await git(work, 'commit', '--quiet', '-m', `${name} ${branch}`);
        await git(work, 'push', '--quiet', bare, `HEAD:refs/heads/${branch}`);
    }
    return bare;
}

const url = (bare: string) => pathToFileURL(bare).href;

function ports(rows: unknown[], registered: Array<{ id: string; path: string }> = []) {
    const workspaces = new Map<string, { id: string; path: string; asleep: boolean }>(registered.map((w) => [w.id, { ...w, asleep: false }]));
    const clones: string[] = [];
    const p: WorkspaceOpsPorts = {
        fs: {
            ...nodeWorkspaceFs(),
            gitClone: (u, into, branch) => { clones.push(u); return gitClone(u, into, undefined, branch); },
            gitAddSubmodule: (envelope, u, at, branch) => gitAddSubmodule(envelope, u, at, branch),
        },
        registry: {
            workspace: (id) => workspaces.get(id) ?? null,
            list: () => [...workspaces.values()],
            addWorkspace: async (w) => { workspaces.set(w.id, { ...w, asleep: false }); },
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
        tynn: { host: 'https://tynn.ai', projects: async () => rows },
    };
    return { ports: p, workspaces, clones };
}

/** A projectRow() as Tynn sends it. */
const row = (over: Record<string, unknown>) => ({ id: 42, name: 'Acme Shop', slug: 'acme', vision: 'Sell things.', is_workspace: true, is_gapp: false, sacred_agent_name: null, repositories: [], envelope: null, envelope_status: 'none', ...over });

const LINK = { host: 'https://tynn.ai', project: 'acme', projectId: '42' };

describe('envelope present: Genie clones the container Tynn names, with its submodules, on its branch', () => {
    it('the clone has the branch’s commit and its submodule checked out; project.json gains the tynn link and keeps the rest', async () => {
        const api = await bareRepo('api', { main: { 'API.md': 'the api\n' } });
        // The envelope's own work tree: a project.json with no tynn link, a submodule, and a branch `trunk` that is not
        // the bare repo's HEAD — so only a clone that asked for Tynn's default_branch lands on it.
        const work = join(dir, 'work', 'acme.agi');
        const envelope = join(dir, 'remotes', 'acme.agi.git');
        await mkdir(join(dir, 'remotes'), { recursive: true });
        await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', envelope]);
        await run('git', ['init', '--quiet', '--initial-branch=main', work]);
        await writeFile(join(work, 'project.json'), `${JSON.stringify({ name: 'Acme Shop', type: 'agi', hosting: { enabled: false }, repos: [{ name: 'api', slug: 'api', path: 'repos/api', url: url(api) }] }, null, 2)}\n`);
        await git(work, 'add', 'project.json');
        await git(work, 'commit', '--quiet', '-m', 'envelope');
        await git(work, 'push', '--quiet', envelope, 'HEAD:refs/heads/main');
        await git(work, 'checkout', '--quiet', '-b', 'trunk');
        await git(work, 'submodule', 'add', '--quiet', '--', url(api), 'repos/api');
        await writeFile(join(work, 'TRUNK.md'), 'only on trunk\n');
        await git(work, 'add', '--all');
        await git(work, 'commit', '--quiet', '-m', 'trunk with the api');
        await git(work, 'push', '--quiet', envelope, 'HEAD:refs/heads/trunk');

        const f = ports([row({ envelope: { repository_id: 7, url: url(envelope), default_branch: 'trunk', kind: 'envelope', clone_url: url(envelope), repo_owner: 'example-org', repo_name: 'acme.agi', reason: null }, envelope_status: 'present', repositories: [{ id: 7, url: url(envelope), default_branch: 'trunk', kind: 'envelope' }] })]);
        const result = await addWorkspaceFromTynn(f.ports, parent, '42');
        expect(result).toMatchObject({ ok: true, id: 'acme' });
        const ws = join(parent, 'acme.agi');
        expect(f.clones).toEqual([url(envelope)]);
        expect(f.workspaces.get('acme')?.path.replace(/\\/g, '/')).toBe(ws.replace(/\\/g, '/'));

        expect(await git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
        expect(await readFile(join(ws, 'TRUNK.md'), 'utf8')).toBe('only on trunk\n');
        // The submodule came down with it (Genie 1's --recurse-submodules): its file is there, not an empty folder.
        expect(await readFile(join(ws, 'repos', 'api', 'API.md'), 'utf8')).toBe('the api\n');
        // Initialised and at the recorded commit: no `-` (not initialised) or `+` (elsewhere) before the sha.
        expect(await git(ws, 'submodule', 'status')).toMatch(/^[0-9a-f]{40} repos\/api /);

        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as Record<string, unknown>;
        expect(manifest.tynn).toEqual(LINK);
        expect(manifest).toMatchObject({ name: 'Acme Shop', hosting: { enabled: false }, repos: [{ name: 'api', path: 'repos/api' }] });
        // The only change Genie made to the person's envelope is the link: project.json modified, nothing else.
        // (`git()` trims, so porcelain's leading space before the M is gone: one line, one modified file.)
        expect((await git(ws, 'status', '--porcelain')).split('\n')).toEqual(['M project.json']);
    }, 120_000);

    it('an envelope that already carries the same link is left exactly as cloned', async () => {
        const envelope = await bareRepo('acme.agi', { main: { 'project.json': `${JSON.stringify({ name: 'Acme Shop', type: 'agi', repos: [], tynn: LINK }, null, 2)}\n` } });
        const f = ports([row({ envelope: { clone_url: url(envelope), url: url(envelope), default_branch: 'main', repo_owner: 'example-org', repo_name: 'acme.agi' }, envelope_status: 'present' })]);
        expect(await addWorkspaceFromTynn(f.ports, parent, '42')).toMatchObject({ ok: true, id: 'acme' });
        const ws = join(parent, 'acme.agi');
        expect(await git(ws, 'status', '--porcelain')).toBe('');
        // Positive control: the probe sees a change to project.json in this same clone.
        await writeFile(join(ws, 'project.json'), '{}\n');
        expect(await git(ws, 'status', '--porcelain')).toBe('M project.json');
    }, 120_000);
});

describe('no envelope but repositories: a new envelope with each repo a submodule under repos/, tracking its branch', () => {
    it('two commits on main; each submodule at its branch’s commit; .gitmodules and project.json say so; clean', async () => {
        const api = await bareRepo('api', { main: { 'API.md': 'api main\n' }, develop: { 'DEVELOP.md': 'only on develop\n' } });
        const web = await bareRepo('web', { main: { 'WEB.md': 'web main\n' } });
        // Tynn lists the envelope-kind repository too when it has one; envelope_status 'none' means none is named.
        const f = ports([row({ repositories: [{ id: 1, url: url(api), default_branch: 'develop', kind: 'code' }, { id: 2, url: url(web), default_branch: null, kind: 'code' }] })]);
        expect(await addWorkspaceFromTynn(f.ports, parent, '42')).toMatchObject({ ok: true, id: 'acme' });
        const ws = join(parent, 'acme.agi');
        expect(f.clones).toEqual([]);
        expect(f.workspaces.has('acme')).toBe(true);

        expect(await git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect(await git(ws, 'rev-list', '--count', 'HEAD')).toBe('2');
        expect(await git(ws, 'log', '-1', '--format=%s')).toBe('Add 2 repositories from Tynn project Acme Shop as submodules');

        const status = (await git(ws, 'submodule', 'status')).split('\n').map((l) => l.trim().split(' ')[1]);
        expect(status).toEqual(['repos/api', 'repos/web']);
        // api tracks develop: its checkout is develop's commit, which carries the file main does not.
        expect(await readFile(join(ws, 'repos', 'api', 'DEVELOP.md'), 'utf8')).toBe('only on develop\n');
        expect(await git(join(ws, 'repos', 'api'), 'rev-parse', 'HEAD')).toBe(await git(join(dir, 'remotes', 'api.git'), 'rev-parse', 'develop'));
        expect(await readFile(join(ws, 'repos', 'web', 'WEB.md'), 'utf8')).toBe('web main\n');
        expect(await git(ws, 'config', '-f', '.gitmodules', 'submodule.repos/api.branch')).toBe('develop');
        // No branch from Tynn: the branch the remote checked out is recorded, not a guessed 'main'… which here IS main.
        expect(await git(ws, 'config', '-f', '.gitmodules', 'submodule.repos/web.branch')).toBe('main');

        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as Record<string, unknown>;
        expect(manifest).toMatchObject({ name: 'Acme Shop', description: 'Sell things.', type: 'agi', tynn: LINK });
        expect(manifest.repos).toEqual([
            { name: 'api', slug: 'api', path: 'repos/api', url: url(api), branch: 'develop' },
            { name: 'web', slug: 'web', path: 'repos/web', url: url(web), branch: 'main' },
        ]);
        // The envelope's own scaffold is in the first commit, as New makes it.
        expect((await git(ws, 'ls-files')).split('\n')).toEqual(expect.arrayContaining(['.gitignore', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'RULES.md', 'project.json', '.gitmodules', 'repos/api', 'repos/web']));
        expect(await git(ws, 'status', '--porcelain')).toBe('');
    }, 120_000);

    it('a repository git cannot fetch is a refusal in git’s words, and nothing is registered', async () => {
        const f = ports([row({ repositories: [{ id: 1, url: url(join(dir, 'remotes', 'gone.git')), default_branch: 'main', kind: 'code' }] })]);
        const result = await addWorkspaceFromTynn(f.ports, parent, '42');
        expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/could not add .*gone\.git as repos\/gone: .*(does not exist|not found|repository)/is) });
        expect(f.workspaces.size).toBe(0);
    }, 120_000);
});

describe('neither: an empty envelope with its first commit', () => {
    it('one commit on main, no submodules, the tynn link in project.json; the same probe finds .gitmodules when there are repos', async () => {
        const f = ports([row({})]);
        expect(await addWorkspaceFromTynn(f.ports, parent, '42')).toMatchObject({ ok: true, id: 'acme', kind: 'empty' });
        const ws = join(parent, 'acme.agi');
        expect(await git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect(await git(ws, 'rev-list', '--count', 'HEAD')).toBe('1');
        const tracked = (await git(ws, 'ls-files')).split('\n');
        expect(tracked).toContain('repos/.gitkeep');
        expect(tracked).not.toContain('.gitmodules');
        expect(await git(ws, 'submodule', 'status')).toBe('');
        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as Record<string, unknown>;
        expect(manifest).toMatchObject({ name: 'Acme Shop', description: 'Sell things.', repos: [], tynn: LINK });
        expect(await git(ws, 'status', '--porcelain')).toBe('');
        expect(f.clones).toEqual([]);

        // Positive control for the absences above: the same probes on a workspace WITH a repo find it.
        const web = await bareRepo('web', { main: { 'WEB.md': 'w\n' } });
        const g = ports([row({ id: 43, slug: 'acme-two', repositories: [{ id: 2, url: url(web), default_branch: 'main', kind: 'code' }] })]);
        expect(await addWorkspaceFromTynn(g.ports, parent, '43')).toMatchObject({ ok: true });
        const two = join(parent, 'acme-two.agi');
        expect((await git(two, 'ls-files')).split('\n')).toContain('.gitmodules');
        expect(await git(two, 'submodule', 'status')).not.toBe('');
    }, 120_000);
});

describe('already added: a project linked to a workspace here is opened, never cloned a second time', () => {
    async function existing(projectId: string): Promise<string> {
        const path = join(dir, 'elsewhere', 'acme-old.agi');
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'project.json'), JSON.stringify({ name: 'Acme', type: 'agi', tynn: { host: 'https://tynn.ai', project: 'acme', projectId } }));
        return path;
    }

    it('the list marks the linked project with its workspace, and only that one', async () => {
        const path = await existing('42');
        const f = ports([row({}), row({ id: 43, name: 'Other', slug: 'other' })], [{ id: 'acme-old', path }, { id: 'unlinked', path: join(dir, 'nowhere') }]);
        const listed = await listTynnProjects(f.ports);
        if (!listed.ok) throw new Error(listed.reason);
        expect(listed.added).toEqual({ '42': 'acme-old' });
        expect(listed.projects.map((p) => p.id)).toEqual(['42', '43']);
    }, 60_000);

    it('preview and confirm both refuse with the workspace to open; nothing is cloned or written', async () => {
        const path = await existing('42');
        const envelope = await bareRepo('acme.agi', { main: { 'project.json': '{}\n' } });
        const f = ports([row({ envelope: { clone_url: url(envelope), default_branch: 'main' }, envelope_status: 'present' })], [{ id: 'acme-old', path }]);
        const refusal = { ok: false, reason: 'Acme Shop is already added here, as the workspace acme-old. Open that workspace instead.', workspaceId: 'acme-old' };
        expect(await previewAddFromTynn(f.ports, parent, '42')).toEqual(refusal);
        expect(await addWorkspaceFromTynn(f.ports, parent, '42')).toEqual(refusal);
        expect(f.clones).toEqual([]);
        expect(await readdir(parent)).toEqual([]);
        expect([...f.workspaces.keys()]).toEqual(['acme-old']);

        // Positive control: the same project, once the link names another project, IS cloned.
        await writeFile(join(path, 'project.json'), JSON.stringify({ name: 'Acme', type: 'agi', tynn: { host: 'https://tynn.ai', project: 'acme', projectId: '999' } }));
        expect(await addWorkspaceFromTynn(f.ports, parent, '42')).toMatchObject({ ok: true, id: 'acme' });
        expect(f.clones).toEqual([url(envelope)]);
        expect(await readdir(parent)).toEqual(['acme.agi']);
    }, 120_000);
});
