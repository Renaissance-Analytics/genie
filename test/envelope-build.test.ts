import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlan, patchRepo, setMonorepoMode, startDraft, type SourceAnalysis, type WizardDraft } from '../src/core/envelope-plan.js';
import { analyseFolder, nodeEnvelopePorts } from '../src/main/envelope-fs.js';
import { buildEnvelope, discardStaged, readSource, registerExisting, stageFromGit, type EnvelopePorts } from '../src/main/envelope-wizard-host.js';
import { nodeWorkspaceFs } from '../src/main/workspace-fs.js';
import { gitAddSubmodule, gitClone } from '../src/main/git-ports.js';
import type { WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * OPEN EXISTING FOLDER / IMPORT FROM GIT BUILD A NEW `<slug>.agi` AND NEVER TOUCH THE SOURCE (Add workspace parity item
 * 7). Genie 2 wrapped the person's folder in place — project.json, .ai/, sandbox/, .trash/ written into their repo.
 * Genie 1's wizard (InteractiveUpgradeWizard + create-agi.ts convertToAgiPlan) built a NEW envelope beside it: the repos
 * as submodules (from their remote, or from the folder on disk), knowledge COPIED out, the source untouched.
 *
 * Measured with the REAL git and the SAME functions main.ts hands the build (envelope-fs.ts, workspace-fs.ts), on three
 * real fixtures — a single repo, a monorepo with a declared submodule and a nested clone, a collection of repos — each
 * with its own bare "remote". The source's whole tree (every file's bytes, .git included) is hashed before and after,
 * and its `git status` compared; the envelope's tree, .gitmodules, commits and each disposition are read back from disk.
 * Git's global config is a file this test owns; the person's own is never read.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
/** Local clones and submodules from paths need this since git 2.38 (CVE-2022-39253); the fixtures set it per command. */
const gitFile = (cwd: string, ...args: string[]) => git(cwd, '-c', 'protocol.file.allow=always', ...args);

const exists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };

/** Every file under `root` (a `.git` included), as `path → sha256`, plus every directory: the source, byte for byte. */
async function treeHash(root: string): Promise<string> {
    const lines: string[] = [];
    const walk = async (dir: string) => {
        for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = join(dir, e.name);
            const rel = relative(root, p).replace(/\\/g, '/');
            if (e.isDirectory()) { lines.push(`d ${rel}`); await walk(p); }
            else if (e.isFile()) lines.push(`f ${rel} ${createHash('sha256').update(await readFile(p)).digest('hex')}`);
            else lines.push(`? ${rel}`);
        }
    };
    await walk(root);
    return lines.join('\n');
}

let dir: string;
let parent: string;
let remotes: string;
let staging: string;
let registered: Map<string, { id: string; path: string; asleep: boolean; envFile?: string }>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-envelope-'));
    parent = join(dir, 'parent');
    remotes = join(dir, 'remotes');
    staging = join(dir, 'staging');
    for (const d of [parent, remotes, staging]) await mkdir(d);
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
        // The same git ports main.ts hands the ops (main.ts adds the GitHub sign-in's credential; these fixtures need none).
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
        // Settings → General "Env file name" (#1104): every add path records it; a non-default value shows it was read.
        defaultEnvFile: () => '.env.local',
        sleep: async () => {},
    };
}
const env = (): EnvelopePorts => nodeEnvelopePorts({ stagingBase: staging });

/** A repository with files committed on `branch`, and (optionally) a bare clone of it as its `origin`. */
async function repo(path: string, files: Record<string, string>, opts: { branch?: string; origin?: boolean } = {}): Promise<string | null> {
    await mkdir(path, { recursive: true });
    await git(path, 'init', '--quiet', `--initial-branch=${opts.branch ?? 'main'}`);
    for (const [f, text] of Object.entries(files)) {
        await mkdir(join(path, f, '..'), { recursive: true });
        await writeFile(join(path, f), text);
    }
    await git(path, 'add', '--all');
    await git(path, 'commit', '--quiet', '-m', 'first');
    if (!opts.origin) return null;
    const bare = join(remotes, `${path.split(/[\\/]/).pop()}.git`);
    await git(dir, 'clone', '--quiet', '--bare', path, bare);
    await git(path, 'remote', 'add', 'origin', bare);
    return bare;
}

/** The single repo: on `trunk`, with tracked docs, an untracked note, a gitignored .ai/ and .env. */
async function singleRepo() {
    const src = join(parent, 'acme-app');
    const bare = await repo(src, { 'README.md': '# Acme\n', 'src/index.ts': 'export {};\n', 'docs/guide.md': 'guide\n', '.gitignore': '.ai/\n.env\n' }, { branch: 'trunk', origin: true });
    await writeFile(join(src, 'notes.md'), 'a loose note\n');
    await mkdir(join(src, '.ai'));
    await writeFile(join(src, '.ai', 'plan.md'), 'the plan\n');
    await writeFile(join(src, '.env'), 'SECRET=1\n');
    return { src, bare: bare! };
}

/** Read, then build, measuring the source before and after. */
async function buildFrom(src: string, shape: (d: WizardDraft) => WizardDraft = (d) => d) {
    // `git status` may refresh .git/index, so it runs OUTSIDE the hashed window: only the read and the build are inside it.
    await git(src, 'status', '--porcelain').catch(() => '');
    const statusBefore = await git(src, 'status', '--porcelain', '--untracked-files=all').catch(() => null);
    const before = await treeHash(src);
    const read = await readSource(ops(), env(), src);
    expect(read).toMatchObject({ ok: true, existing: false });
    const analysis = (read as { analysis: SourceAnalysis }).analysis;
    const plan = buildPlan(shape(startDraft(analysis, { parent })));
    const built = await buildEnvelope(ops(), env(), plan);
    expect(built).toMatchObject({ ok: true });
    expect(await treeHash(src)).toBe(before);
    // Positive control for the gauge: the hash does see a one-byte change in the source (then it is put back).
    await writeFile(join(src, 'probe.tmp'), 'x');
    expect(await treeHash(src)).not.toBe(before);
    await rm(join(src, 'probe.tmp'));
    expect(await treeHash(src)).toBe(before);
    expect(await git(src, 'status', '--porcelain', '--untracked-files=all').catch(() => null)).toBe(statusBefore);
    return { analysis, plan, ...(built as { id: string; path: string }) };
}

describe('the analysis reads the folder as Genie 1 did', () => {
    it('a single repo: one candidate from its origin and branch, and each top-level entry by its git state', async () => {
        const { src, bare } = await singleRepo();
        const a = await analyseFolder(src);
        expect(a.sourceKind).toBe('single-repo');
        expect(a.repos).toEqual([{ relPath: '.', absPath: src, defaultName: 'acme-app', originUrl: bare, headRef: 'trunk' }]);
        const by = Object.fromEntries((a.rootEntries ?? []).map((e) => [e.relPath, [e.gitState, e.suggested, e.suggestedTarget]]));
        expect(by).toEqual({
            '.ai': ['ignored', 'knowledge', ''],
            '.env': ['ignored', 'codebase', ''],
            '.gitignore': ['tracked', 'codebase', ''],
            'README.md': ['tracked', 'codebase', ''],
            docs: ['tracked', 'codebase', ''],
            'notes.md': ['untracked', 'knowledge', 'knowledge'],
            src: ['tracked', 'codebase', ''],
        });
        expect(a.submodules).toEqual([]);
    }, 60_000);
});

describe('a single repo becomes ONE submodule of a new envelope beside it', () => {
    it('Local: the envelope is built, committed twice, registered — and the source is byte-identical', async () => {
        const { src } = await singleRepo();
        const head = await git(src, 'rev-parse', 'HEAD');
        const b = await buildFrom(src, (d) => patchRepo(renameAcme(d), '.', { source: 'local' }));
        const ws = join(parent, 'acme.agi');
        expect(b.path).toBe(ws);
        expect(b.id).toBe('acme');
        expect(registered.get('acme')).toMatchObject({ path: ws, envFile: '.env.local' });

        // Two commits: Genie 2's real first commit (the New path, genie#1094), then Genie 1's convert commit.
        expect(await git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect((await git(ws, 'log', '--format=%s')).split('\n')).toEqual(['Convert: migrate 1 submodule + 2 knowledge items', 'Initial commit — acme.agi envelope scaffolded by Genie']);
        expect(await git(ws, 'status', '--porcelain')).toBe('');

        // The submodule: named, from the folder on disk, at the source's commit, tracking the source's branch.
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/acme-app.path')).toBe('repos/acme-app');
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/acme-app.url')).toBe(src);
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/acme-app.branch')).toBe('trunk');
        expect(await git(join(ws, 'repos', 'acme-app'), 'rev-parse', 'HEAD')).toBe(head);
        expect(await readFile(join(ws, 'repos', 'acme-app', 'README.md'), 'utf8')).toBe('# Acme\n');
        // Genie 1 restored a Local source's gitignored .env into the clone, where it stays ignored (never committed).
        expect(await readFile(join(ws, 'repos', 'acme-app', '.env'), 'utf8')).toBe('SECRET=1\n');
        expect(await git(join(ws, 'repos', 'acme-app'), 'status', '--porcelain')).toBe('');

        // Knowledge copied: the untracked note to .ai/knowledge, the gitignored .ai/ spread into .ai/.
        expect(await readFile(join(ws, '.ai', 'knowledge', 'notes.md'), 'utf8')).toBe('a loose note\n');
        expect(await readFile(join(ws, '.ai', 'plan.md'), 'utf8')).toBe('the plan\n');
        // Codebase stays in the repo: the tracked docs/ were not copied out (positive control: they are in the submodule).
        expect(await exists(join(ws, '.ai', 'knowledge', 'guide.md'))).toBe(false);
        expect(await exists(join(ws, 'repos', 'acme-app', 'docs', 'guide.md'))).toBe(true);

        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as Record<string, unknown>;
        expect(manifest).toMatchObject({
            name: 'Acme',
            $schema: expect.stringContaining('Civicognita/shared-schemas'),
            primaryRepo: 'acme-app',
            repos: [{ name: 'acme-app', slug: 'acme-app', url: src, path: 'repos/acme-app', role: 'host', branch: 'trunk' }],
        });
    }, 120_000);

    it('Origin: the submodule comes from the repo’s remote, and the source is byte-identical', async () => {
        const { src, bare } = await singleRepo();
        const b = await buildFrom(src, renameAcme);
        expect(await git(b.path, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/acme-app.url')).toBe(bare);
        expect(await git(b.path, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/acme-app.branch')).toBe('trunk');
        // Origin brings only what the remote has: no .env restored (that was Local's, from the folder on disk).
        expect(await exists(join(b.path, 'repos', 'acme-app', '.env'))).toBe(false);
        expect(await exists(join(b.path, 'repos', 'acme-app', 'README.md'))).toBe(true);
    }, 120_000);

    it('each disposition: Root beside project.json, Ignore left out — measured against the defaults', async () => {
        const { src } = await singleRepo();
        const b = await buildFrom(src, (d) => ({
            ...renameAcme(d),
            dispositions: d.dispositions.map((r) => (r.relPath === 'notes.md' ? { ...r, disposition: 'root' as const } : r.relPath === '.ai' ? { ...r, disposition: 'ignore' as const } : r.relPath === 'docs' ? { ...r, disposition: 'knowledge' as const, targetSubdir: 'plans' } : r)),
        }));
        expect(await readFile(join(b.path, 'notes.md'), 'utf8')).toBe('a loose note\n');
        expect(await exists(join(b.path, '.ai', 'knowledge', 'notes.md'))).toBe(false);
        expect(await exists(join(b.path, '.ai', 'plan.md'))).toBe(false);
        // A tracked folder flipped to Knowledge is copied (its contents into the target) — and is still in the repo.
        expect(await readFile(join(b.path, '.ai', 'plans', 'guide.md'), 'utf8')).toBe('guide\n');
        expect(await git(b.path, 'log', '-1', '--format=%s')).toBe('Convert: migrate 1 submodule + 2 knowledge items');
        expect(await git(b.path, 'ls-files', 'notes.md', '.ai/plans/guide.md')).toBe('.ai/plans/guide.md\nnotes.md');
    }, 120_000);

    it('refuses an envelope inside the source, and writes nothing there', async () => {
        const { src } = await singleRepo();
        const before = await treeHash(src);
        const read = await readSource(ops(), env(), src);
        const plan = buildPlan(startDraft((read as { analysis: SourceAnalysis }).analysis, { parent: src }));
        const r = await buildEnvelope(ops(), env(), plan);
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/inside/) });
        expect(await treeHash(src)).toBe(before);
        expect(registered.size).toBe(0);
    }, 60_000);
});

describe('a monorepo', () => {
    async function monorepo() {
        const uiSrc = join(dir, 'ui-src');
        const uiBare = await repo(uiSrc, { 'ui.ts': 'ui\n' }, { origin: true });
        const src = join(parent, 'mono');
        await repo(src, { 'package.json': '{}\n' });
        await gitFile(src, 'submodule', 'add', '--quiet', '--name', 'ui', '--', uiBare!, 'packages/ui');
        await git(src, 'commit', '--quiet', '-m', 'ui');
        // An independent clone at the top level, declared nowhere (the npm-workspaces pattern), with no remote.
        await repo(join(src, 'tools'), { 'tool.sh': 'echo\n' }, { branch: 'dev' });
        return { src, uiBare: uiBare! };
    }

    it('EXPLODE: each member its own submodule with its branch; the host named; the monorepo byte-identical', async () => {
        const { src, uiBare } = await monorepo();
        const b = await buildFrom(src, (d) => renameWorkspaceTo(d, 'Mono'));
        expect(b.analysis.sourceKind).toBe('monorepo');
        expect(b.analysis.submodules.map((s) => [s.name, s.path])).toEqual([['ui', 'packages/ui'], ['tools', 'tools']]);
        const ws = b.path;
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/ui.url')).toBe(uiBare);
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/ui.branch')).toBe('main');
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/tools.url')).toBe(join(src, 'tools'));
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/tools.branch')).toBe('dev');
        expect(await readFile(join(ws, 'repos', 'ui', 'ui.ts'), 'utf8')).toBe('ui\n');
        expect(await readFile(join(ws, 'repos', 'tools', 'tool.sh'), 'utf8')).toBe('echo\n');
        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as { primaryRepo: string; repos: Array<{ name: string; role: string }> };
        expect(manifest.primaryRepo).toBe('ui');
        expect(manifest.repos.map((r) => [r.name, r.role])).toEqual([['ui', 'host'], ['tools', 'package']]);
        expect(await git(ws, 'log', '-1', '--format=%s')).toBe('Convert: migrate 2 submodules');
    }, 120_000);

    it('WRAP: the whole monorepo as one submodule, its own .gitmodules inside it', async () => {
        const { src } = await monorepo();
        const b = await buildFrom(src, (d) => renameWorkspaceTo(setMonorepoMode(d, 'wrap'), 'Mono'));
        expect(await git(b.path, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/mono.url')).toBe(src);
        expect(await exists(join(b.path, 'repos', 'mono', '.gitmodules'))).toBe(true);
        expect(await exists(join(b.path, 'repos', 'ui'))).toBe(false);
    }, 120_000);
});

describe('a collection of repos', () => {
    it('each repo its own submodule (Origin and Local), knowledge copied, the rest left in the source', async () => {
        const coll = join(parent, 'coll');
        const apiBare = await repo(join(coll, 'api'), { 'api.ts': 'api\n' }, { origin: true });
        await repo(join(coll, '_web'), { 'web.ts': 'web\n' });
        await mkdir(join(coll, 'plans'));
        await writeFile(join(coll, 'plans', 'a.md'), 'plan a\n');
        await writeFile(join(coll, 'README.md'), 'collection\n');
        await mkdir(join(coll, 'misc'));
        await writeFile(join(coll, 'misc', 'x.bin'), 'x');
        const statusApi = await git(join(coll, 'api'), 'status', '--porcelain');
        const statusWeb = await git(join(coll, '_web'), 'status', '--porcelain');

        const b = await buildFrom(coll, (d) => renameWorkspaceTo(d, 'Coll'));
        expect(b.analysis.sourceKind).toBe('repo-collection');
        expect(b.analysis.other).toEqual([{ relPath: 'misc', kind: 'directory' }]);
        const ws = b.path;
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/api.url')).toBe(apiBare);
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/web.url')).toBe(join(coll, '_web'));
        expect(await git(ws, 'config', '-f', '.gitmodules', '--get', 'submodule.repos/web.path')).toBe('repos/web');
        expect(await readFile(join(ws, '.ai', 'plans', 'a.md'), 'utf8')).toBe('plan a\n');
        expect(await readFile(join(ws, '.ai', 'knowledge', 'README.md'), 'utf8')).toBe('collection\n');
        expect(await exists(join(ws, 'misc'))).toBe(false);
        expect(await git(ws, 'log', '-1', '--format=%s')).toBe('Convert: migrate 2 submodules + 2 knowledge items');
        // Each source repo: clean before, clean after.
        expect(statusApi).toBe('');
        expect(await git(join(coll, 'api'), 'status', '--porcelain')).toBe('');
        expect(statusWeb).toBe('');
        expect(await git(join(coll, '_web'), 'status', '--porcelain')).toBe('');
        // No host among several with none named.
        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as { primaryRepo: string };
        expect(manifest.primaryRepo).toBe('');
    }, 120_000);
});

describe('an existing envelope', () => {
    it('is only registered: nothing in it is written', async () => {
        const ws = join(parent, 'have.agi');
        await repo(ws, {
            'project.json': `${JSON.stringify({ $schema: 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.3.0/schemas/workspace/project.schema.json', name: 'Have', repos: [] }, null, 2)}\n`,
            'repos/.gitkeep': '',
            '.ai/.gitkeep': '',
        });
        const before = await treeHash(ws);
        const read = await readSource(ops(), env(), ws);
        expect(read).toEqual({ ok: true, existing: true, path: ws });
        expect(await registerExisting(ops(), ws)).toEqual({ ok: true, id: 'have' });
        expect(registered.get('have')).toMatchObject({ path: ws, envFile: '.env.local' });
        expect(await treeHash(ws)).toBe(before);
    }, 60_000);
});

describe('Import from Git: the clone waits in a staging folder, goes through the same wizard, and is removed after', () => {
    it('stages, builds from the remote, removes the staging clone; the remote is untouched', async () => {
        const { bare } = await singleRepo();
        const remoteBefore = await treeHash(bare);
        const read = await stageFromGit(ops(), env(), bare);
        expect(read).toMatchObject({ ok: true, existing: false, staged: true });
        const analysis = (read as { analysis: SourceAnalysis }).analysis;
        expect(analysis.root.startsWith(staging)).toBe(true);
        expect(analysis.sourceKind).toBe('single-repo');
        expect(await exists(analysis.root)).toBe(true);

        const plan = buildPlan(renameWorkspaceTo(startDraft(analysis, { parent, staged: true }), 'Imported'));
        expect(plan.repos).toEqual([{ name: 'acme-app', url: bare, local: false }]);
        const built = await buildEnvelope(ops(), env(), plan);
        expect(built).toMatchObject({ ok: true, path: join(parent, 'imported.agi') });
        expect(await git(join(parent, 'imported.agi'), 'config', '-f', '.gitmodules', '--get', 'submodule.repos/acme-app.url')).toBe(bare);
        // The staging clone is gone; the place it was in is the stage's own, not the person's.
        expect(await exists(analysis.root)).toBe(false);
        expect(await treeHash(bare)).toBe(remoteBefore);
    }, 120_000);

    it('cancelled: the staging clone is discarded — and only a folder the stage made is ever removed', async () => {
        const { src, bare } = await singleRepo();
        const read = await stageFromGit(ops(), env(), bare);
        const root = (read as { analysis: SourceAnalysis }).analysis.root;
        expect(await exists(root)).toBe(true);
        await discardStaged(env(), root);
        expect(await exists(root)).toBe(false);
        // The person's own folder is not the stage's: asking to discard it removes nothing.
        const before = await treeHash(src);
        await discardStaged(env(), src);
        expect(await treeHash(src)).toBe(before);
    }, 120_000);
});

function renameAcme(d: WizardDraft): WizardDraft {
    return renameWorkspaceTo(d, 'Acme');
}
function renameWorkspaceTo(d: WizardDraft, name: string): WizardDraft {
    return { ...d, name, nameTouched: true };
}
