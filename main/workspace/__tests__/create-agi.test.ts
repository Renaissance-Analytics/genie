import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import {
    addStructureDocs,
    classifyClaude,
    consolidateMcpAndCommit,
    convertToAgi,
    convertToAgiPlan,
    copyEnvFiles,
    createAgiEnvelope,
    deriveRepoName,
    envelopeFolderName,
    repairWorkspaceDocs,
    structureDocStatus,
    symlinksSupported,
    syncClaudeFromAgents,
    workspaceDocHealth,
} from '../create-agi';
import { readProjectJson } from '../project-json';
import { cleanupTmpRoot, makeTmpDir, seedGitRepo } from '../../../test/helpers';

// These tests spawn many git subprocesses (envelope conversion, submodule
// explode). On Windows that overhead routinely exceeds the global 20s timeout
// even though the same tests pass comfortably on Linux CI — give the whole file
// headroom so local Windows runs don't flake.
vi.setConfig({ testTimeout: 120_000 });

afterAll(() => cleanupTmpRoot());

describe('deriveRepoName', () => {
    it('extracts the repo name from common URL shapes', () => {
        expect(deriveRepoName('https://github.com/owner/repo.git')).toBe('repo');
        expect(deriveRepoName('git@github.com:owner/repo.git')).toBe('repo');
        expect(deriveRepoName('https://gitlab.example.com/group/sub/project')).toBe('project');
        expect(deriveRepoName('ssh://git@host:22/path/to/RepoName.git')).toBe('RepoName');
    });

    it('handles trailing slashes and mixed separators', () => {
        expect(deriveRepoName('https://github.com/owner/repo/')).toBe('repo');
        expect(deriveRepoName('https://github.com/owner/repo.git/')).toBe('repo');
        expect(deriveRepoName('C:\\projects\\foo')).toBe('foo');
        expect(deriveRepoName('C:\\projects\\foo\\')).toBe('foo');
    });

    it('falls back to a default for degenerate input', () => {
        expect(deriveRepoName('')).toBe('repo');
        expect(deriveRepoName('/')).toBe('repo');
    });
});

describe('envelopeFolderName', () => {
    it('appends .agi to a bare slug', () => {
        expect(envelopeFolderName('brain-v2')).toBe('brain-v2.agi');
    });
    it('does not double the suffix', () => {
        expect(envelopeFolderName('brain-v2.agi')).toBe('brain-v2.agi');
        expect(envelopeFolderName('brain-v2.AGI')).toBe('brain-v2.AGI');
    });
});

describe('createAgiEnvelope', () => {
    it('scaffolds the skeleton + initial commit', async () => {
        const parent = makeTmpDir('cae-scaffold');
        const res = await createAgiEnvelope({
            slug: 'test-env',
            name: 'Test',
            parent_path: parent,
        });

        // Folder carries the .agi suffix (the envelope convention).
        expect(res.path).toBe(path.join(parent, 'test-env.agi'));
        expect(res.git_log_count).toBe(1);

        // Required skeleton dirs exist.
        for (const d of [
            'repos',
            '.ai',
            '.ai/plans',
            '.ai/knowledge',
            '.ai/pm',
            '.ai/chat',
            '.ai/memory',
            '.ai/issues',
            'sandbox',
            '.trash',
        ]) {
            expect(fs.existsSync(path.join(res.path, d)), `missing dir ${d}`).toBe(true);
        }

        // Marker files present.
        expect(fs.existsSync(path.join(res.path, 'project.json'))).toBe(true);
        expect(fs.existsSync(path.join(res.path, '.gitignore'))).toBe(true);
        expect(fs.existsSync(path.join(res.path, '.git'))).toBe(true);

        // .gitignore excludes the envelope-owned scratch dirs.
        const gi = fs.readFileSync(path.join(res.path, '.gitignore'), 'utf8');
        expect(gi).toMatch(/sandbox/);
        expect(gi).toMatch(/\.trash/);

        // Structure docs for humans + agents.
        const readme = fs.readFileSync(path.join(res.path, 'README.md'), 'utf8');
        expect(readme).toMatch(/# Test/);
        expect(readme).toMatch(/test-env\.agi/);
        expect(readme).toMatch(/repos\//);
        const agents = fs.readFileSync(path.join(res.path, 'AGENTS.md'), 'utf8');
        expect(agents).toMatch(/AGENTS\.md/);
        expect(agents).toMatch(/submodule/i);

        // CLAUDE.md is committed as a real git symlink (mode 120000)
        // pointing at AGENTS.md — verified via the index, since the
        // working-tree representation is platform-dependent.
        const git = simpleGit(res.path);
        const lsFiles = await git.raw(['ls-files', '-s', 'CLAUDE.md']);
        expect(lsFiles).toMatch(/^120000 /);
        const sha = lsFiles.trim().split(/\s+/)[1];
        const blob = await git.raw(['cat-file', '-p', sha]);
        expect(blob).toBe('AGENTS.md');
    });

    it('refuses to scaffold into a non-empty folder', async () => {
        const parent = makeTmpDir('cae-occupied');
        // The envelope lands at <parent>/occupied.agi — occupy THAT.
        const target = path.join(parent, 'occupied.agi');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'noise'), 'x');

        await expect(
            createAgiEnvelope({
                slug: 'occupied',
                name: 'Test',
                parent_path: parent,
            }),
        ).rejects.toThrow(/not empty/i);
    });

    it('records a paste-style remote when requested', async () => {
        const parent = makeTmpDir('cae-paste');
        const res = await createAgiEnvelope({
            slug: 'with-remote',
            name: 'Remote',
            parent_path: parent,
            remote: { kind: 'paste', url: 'git@github.com:owner/with-remote.agi.git' },
        });

        expect(res.remote).toBe('git@github.com:owner/with-remote.agi.git');
        const git = simpleGit(res.path);
        const remotes = await git.getRemotes(true);
        const origin = remotes.find((r) => r.name === 'origin');
        expect(origin?.refs.push).toBe('git@github.com:owner/with-remote.agi.git');
    });
});

describe('structure docs health + backfill', () => {
    it('reports a freshly-created envelope as complete', async () => {
        const parent = makeTmpDir('sd-fresh');
        const res = await createAgiEnvelope({ slug: 'fresh', name: 'Fresh', parent_path: parent });
        const st = await structureDocStatus(res.path);
        expect(st.isEnvelope).toBe(true);
        expect(st.missing).toBe(false);
        expect(st.hasReadme && st.hasAgents && st.hasClaude).toBe(true);
    });

    it('detects + backfills missing docs and commits them', async () => {
        const parent = makeTmpDir('sd-missing');
        const res = await createAgiEnvelope({ slug: 'gap', name: 'Gap', parent_path: parent });
        // Simulate an older envelope: remove the docs + drop them from git.
        const git = simpleGit(res.path);
        for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
            await git.rm([f]);
            const p = path.join(res.path, f);
            if (fs.existsSync(p)) fs.rmSync(p);
        }
        await git.commit('strip docs');

        const before = await structureDocStatus(res.path);
        expect(before.missing).toBe(true);
        expect(before.hasReadme).toBe(false);

        const r = await addStructureDocs(res.path, 'Gap', 'gap');
        expect(r.added.sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'README.md']);
        expect(r.committed).toBe(true);
        expect(r.pushed).toBe(false); // no remote

        const after = await structureDocStatus(res.path);
        expect(after.missing).toBe(false);
        // CLAUDE.md restored as a real git symlink.
        const ls = await git.raw(['ls-files', '-s', 'CLAUDE.md']);
        expect(ls).toMatch(/^120000 /);
    });

    it('preserves an existing CLAUDE.md and only adds the missing docs', async () => {
        const parent = makeTmpDir('sd-partial');
        const res = await createAgiEnvelope({ slug: 'partial', name: 'Partial', parent_path: parent });
        const git = simpleGit(res.path);
        // Simulate the tynn case: a real CLAUDE.md with bespoke content,
        // no README/AGENTS.
        for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
            await git.rm([f]);
            const p = path.join(res.path, f);
            if (fs.existsSync(p)) fs.rmSync(p);
        }
        const customClaude = '# Project CLAUDE\n\nHand-written, do not touch.\n';
        fs.writeFileSync(path.join(res.path, 'CLAUDE.md'), customClaude);
        await git.add(['CLAUDE.md']);
        await git.commit('custom claude only');

        const r = await addStructureDocs(res.path, 'Partial', 'partial');
        // Only the two genuinely-missing docs were written.
        expect(r.added.sort()).toEqual(['AGENTS.md', 'README.md']);
        // The bespoke CLAUDE.md is byte-for-byte untouched (not symlinked).
        expect(fs.readFileSync(path.join(res.path, 'CLAUDE.md'), 'utf8')).toBe(customClaude);
        const ls = await git.raw(['ls-files', '-s', 'CLAUDE.md']);
        expect(ls).toMatch(/^100644 /); // still a regular file, not a symlink
    });
});

describe('MCP consolidate-and-commit (gitignore-aware)', () => {
    it('writes locally but does NOT commit when the configs are gitignored', async () => {
        const parent = makeTmpDir('mcp-ignored');
        const res = await createAgiEnvelope({ slug: 'sec', name: 'Sec', parent_path: parent });
        // A repo carrying an MCP server.
        const repo = path.join(res.path, 'repos', 'app');
        fs.mkdirSync(repo, { recursive: true });
        fs.writeFileSync(
            path.join(repo, '.mcp.json'),
            JSON.stringify({ mcpServers: { tynn: { command: 'x', env: { TOKEN: 'secret' } } } }),
        );
        // Envelope gitignores the MCP files (the tynn.agi case).
        fs.appendFileSync(path.join(res.path, '.gitignore'), '\n.mcp.json\n.cursor/\n');
        const git = simpleGit(res.path);
        await git.add('.gitignore');
        await git.commit('ignore mcp');

        const r = await consolidateMcpAndCommit(res.path);
        expect(r.gitignored).toBe(true);
        expect(r.committed).toBe(false);
        // Files are still written to disk for local sessions.
        expect(fs.existsSync(path.join(res.path, '.mcp.json'))).toBe(true);
        expect(fs.existsSync(path.join(res.path, '.cursor', 'mcp.json'))).toBe(true);
        // And the secret-bearing config was NOT committed.
        const tracked = await git.raw(['ls-files', '.mcp.json', '.cursor/mcp.json']);
        expect(tracked.trim()).toBe('');
    });

    it('commits + reports when the configs are NOT gitignored', async () => {
        const parent = makeTmpDir('mcp-tracked');
        const res = await createAgiEnvelope({ slug: 'open', name: 'Open', parent_path: parent });
        const repo = path.join(res.path, 'repos', 'app');
        fs.mkdirSync(repo, { recursive: true });
        fs.writeFileSync(
            path.join(repo, '.mcp.json'),
            JSON.stringify({ mcpServers: { docs: { url: 'https://x/mcp' } } }),
        );
        const r = await consolidateMcpAndCommit(res.path);
        expect(r.gitignored).toBeFalsy();
        expect(r.committed).toBe(true);
        expect(r.servers).toContain('docs');
        const git = simpleGit(res.path);
        const tracked = await git.raw(['ls-files', '.mcp.json', '.cursor/mcp.json']);
        expect(tracked).toMatch(/\.mcp\.json/);
        expect(tracked).toMatch(/\.cursor\/mcp\.json/);
    });
});

describe('convertToAgi (local source)', () => {
    it('wraps a local git repo as a submodule under repos/', async () => {
        const source = makeTmpDir('cv-source');
        await seedGitRepo(source);

        const parent = makeTmpDir('cv-dest');
        const res = await convertToAgi({
            slug: 'wrapper',
            name: 'Wrapper',
            parent_path: parent,
            source: { kind: 'local', path: source },
            sub_name: 'core',
        });

        expect(res.path).toBe(path.join(parent, 'wrapper.agi'));
        expect(res.submodule_path).toBe('repos/core');
        expect(res.submodule_url).toBe(source);
        expect(res.git_log_count).toBeGreaterThanOrEqual(2);

        // The submodule entry exists on disk and in .gitmodules.
        expect(fs.existsSync(path.join(res.path, 'repos/core'))).toBe(true);
        const gm = fs.readFileSync(path.join(res.path, '.gitmodules'), 'utf8');
        expect(gm).toMatch(/path = repos\/core/);
    });

    it('rejects a source folder that is not a git repo', async () => {
        const source = makeTmpDir('cv-nogit');
        fs.writeFileSync(path.join(source, 'file.txt'), 'no git here');

        const parent = makeTmpDir('cv-nogit-dest');
        await expect(
            convertToAgi({
                slug: 'broken',
                name: 'Broken',
                parent_path: parent,
                source: { kind: 'local', path: source },
            }),
        ).rejects.toThrow(/not a git repository/i);
    });

    it('rejects an invalid submodule directory name', async () => {
        const source = makeTmpDir('cv-badname-src');
        await seedGitRepo(source);

        const parent = makeTmpDir('cv-badname-dest');
        await expect(
            convertToAgi({
                slug: 'wrapper',
                name: 'Wrapper',
                parent_path: parent,
                source: { kind: 'local', path: source },
                sub_name: '../escape',
            }),
        ).rejects.toThrow(/invalid submodule name/i);
    });
});

describe('local-only paths (no GitHub, no remote)', () => {
    it('createAgiEnvelope with {kind:none} builds a valid local repo and NO remote', async () => {
        const parent = makeTmpDir('local-create');
        const res = await createAgiEnvelope({
            slug: 'localcreate',
            name: 'Local Create',
            parent_path: parent,
            remote: { kind: 'none' },
        });
        expect(res.remote).toBeUndefined();
        expect(res.git_log_count).toBe(1);
        const git = simpleGit(res.path);
        // A real local git repo with an initial commit and zero remotes.
        const remotes = await git.getRemotes();
        expect(remotes.length).toBe(0);
        const log = await git.log();
        expect(log.total).toBe(1);
    });

    it('convertToAgi wraps a no-origin local repo with {kind:none} — local submodule, no remote', async () => {
        const source = makeTmpDir('local-conv-src');
        await seedGitRepo(source); // seedGitRepo never sets an origin
        // No origin remote on the source — the submodule must source from the
        // local path itself, not error on a missing remote.
        const origin = await simpleGit(source).getConfig('remote.origin.url');
        expect(origin.value).toBeFalsy();

        const parent = makeTmpDir('local-conv-dest');
        const res = await convertToAgi({
            slug: 'localwrap',
            name: 'Local Wrap',
            parent_path: parent,
            source: { kind: 'local', path: source },
            sub_name: 'core',
            remote: { kind: 'none' },
        });

        // Submodule materialised from the local path; .gitmodules records it.
        expect(fs.existsSync(path.join(res.path, 'repos/core'))).toBe(true);
        expect(res.submodule_url).toBe(source);
        const gm = fs.readFileSync(path.join(res.path, '.gitmodules'), 'utf8');
        expect(gm).toMatch(/path = repos\/core/);
        // Envelope has no remote — nothing was pushed or required from GitHub.
        const remotes = await simpleGit(res.path).getRemotes();
        expect(remotes.length).toBe(0);
    });

    it('convertToAgiPlan honours is_local for a member whose source is a no-origin local repo', async () => {
        // Mirrors the interactive Upgrade wizard's explode path: a member repo
        // with no GitHub origin is submoduled straight from its local path.
        const mem = makeTmpDir('local-plan-mem');
        await seedGitRepo(mem);
        const parent = makeTmpDir('local-plan-dest');

        const res = await convertToAgiPlan({
            slug: 'localplan',
            name: 'Local Plan',
            parent_path: parent,
            repos: [{ source: mem, is_local: true, submodule_name: 'app' }],
            knowledge: [],
            remote: { kind: 'none' },
        });

        expect(fs.existsSync(path.join(res.path, 'repos', 'app'))).toBe(true);
        const remotes = await simpleGit(res.path).getRemotes();
        expect(remotes.length).toBe(0);
        const pj = readProjectJson(res.path)!;
        expect(pj.repos?.[0].url).toBe(mem);
    });
});

describe('convertToAgiPlan (monorepo explode)', () => {
    it('adds members as submodules with branches + host/package roles', async () => {
        // Three independent member repos — the explode flow sources each by
        // its local path. seedGitRepo leaves them on `main`.
        const memA = makeTmpDir('plan-memA');
        const memB = makeTmpDir('plan-memB');
        const memC = makeTmpDir('plan-memC');
        await seedGitRepo(memA);
        await seedGitRepo(memB);
        await seedGitRepo(memC);

        const parent = makeTmpDir('plan-dest');
        const res = await convertToAgiPlan({
            slug: 'pa-ux-sandbox',
            name: 'PA UX Sandbox',
            parent_path: parent,
            primary: 'host-app',
            repos: [
                { source: memA, is_local: true, submodule_name: 'host-app' },
                { source: memB, is_local: true, submodule_name: 'pkg-one' },
                { source: memC, is_local: true, submodule_name: 'pkg-two' },
            ],
            knowledge: [],
        });

        // All three members are submodules under repos/.
        for (const name of ['host-app', 'pkg-one', 'pkg-two']) {
            expect(fs.existsSync(path.join(res.path, 'repos', name))).toBe(true);
        }

        // .gitmodules records a branch per submodule (enables --remote).
        const gm = fs.readFileSync(path.join(res.path, '.gitmodules'), 'utf8');
        expect(gm).toMatch(/path = repos\/host-app/);
        expect(gm).toMatch(/\[submodule "host-app"\][\s\S]*?branch = main/);
        expect(gm).toMatch(/\[submodule "pkg-one"\][\s\S]*?branch = main/);
        expect(gm).toMatch(/\[submodule "pkg-two"\][\s\S]*?branch = main/);

        // project.json: host designation + roles + path/url/branch.
        const pj = readProjectJson(res.path)!;
        expect(pj.primaryRepo).toBe('host-app');
        expect(pj.hosting?.enabled).toBe(true);

        const byName = new Map((pj.repos ?? []).map((r) => [r.name, r]));
        expect(byName.size).toBe(3);
        expect(byName.get('host-app')!.role).toBe('host');
        expect(byName.get('host-app')!.path).toBe('repos/host-app');
        expect(byName.get('host-app')!.branch).toBe('main');
        expect(byName.get('host-app')!.url).toBe(memA);
        expect(byName.get('pkg-one')!.role).toBe('package');
        expect(byName.get('pkg-two')!.role).toBe('package');
    });

    it('treats a lone repo as the host when no primary is given', async () => {
        const mem = makeTmpDir('plan-lone-src');
        await seedGitRepo(mem);
        const parent = makeTmpDir('plan-lone-dest');

        const res = await convertToAgiPlan({
            slug: 'solo',
            name: 'Solo',
            parent_path: parent,
            repos: [{ source: mem, is_local: true, submodule_name: 'app' }],
            knowledge: [],
        });

        const pj = readProjectJson(res.path)!;
        expect(pj.primaryRepo).toBe('app');
        expect(pj.hosting?.enabled).toBe(true);
        expect(pj.repos?.[0].role).toBe('host');
    });
});

describe('copyEnvFiles', () => {
    it('copies root-level .env / .env.* working files into the submodule dir', () => {
        const src = makeTmpDir('env-src');
        const dst = makeTmpDir('env-dst');
        fs.writeFileSync(path.join(src, '.env'), 'SECRET=1\n');
        fs.writeFileSync(path.join(src, '.env.local'), 'LOCAL=2\n');
        fs.writeFileSync(path.join(src, '.env.production.local'), 'PROD=3\n');
        // Non-env files are NOT copied.
        fs.writeFileSync(path.join(src, 'README.md'), '# readme\n');

        copyEnvFiles(src, dst);

        expect(fs.readFileSync(path.join(dst, '.env'), 'utf8')).toBe('SECRET=1\n');
        expect(fs.readFileSync(path.join(dst, '.env.local'), 'utf8')).toBe('LOCAL=2\n');
        expect(fs.existsSync(path.join(dst, '.env.production.local'))).toBe(true);
        expect(fs.existsSync(path.join(dst, 'README.md'))).toBe(false);
    });

    it('does not recurse — only root-level env files are copied', () => {
        const src = makeTmpDir('env-src-nested');
        const dst = makeTmpDir('env-dst-nested');
        fs.mkdirSync(path.join(src, 'nested'));
        fs.writeFileSync(path.join(src, 'nested', '.env'), 'NESTED=1\n');
        copyEnvFiles(src, dst);
        expect(fs.existsSync(path.join(dst, 'nested'))).toBe(false);
        expect(fs.existsSync(path.join(dst, '.env'))).toBe(false);
    });

    it('is a no-op when the source has no env files', () => {
        const src = makeTmpDir('env-src-empty');
        const dst = makeTmpDir('env-dst-empty');
        fs.writeFileSync(path.join(src, 'package.json'), '{}\n');
        expect(() => copyEnvFiles(src, dst)).not.toThrow();
        expect(fs.readdirSync(dst)).toEqual([]);
    });

    it('does not throw on a missing source dir', () => {
        const dst = makeTmpDir('env-dst-missing');
        expect(() => copyEnvFiles('/no/such/source/dir', dst)).not.toThrow();
        expect(fs.readdirSync(dst)).toEqual([]);
    });
});

describe('syncClaudeFromAgents (symlink-or-mirror)', () => {
    it('repairs a missing CLAUDE.md and brings it into sync (symlink or mirror)', () => {
        const ws = makeTmpDir('claude-missing');
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# AGENTS\n\nbody\n');
        const result = syncClaudeFromAgents(ws);
        // Platform-dependent which path we take — both are "in sync".
        expect(['symlinked', 'mirrored']).toContain(result);
        const kind = classifyClaude(ws);
        expect(['symlink', 'mirror']).toContain(kind);
        if (symlinksSupported()) {
            expect(kind).toBe('symlink');
        } else {
            expect(kind).toBe('mirror');
            // The mirror carries the real AGENTS.md content, not "AGENTS.md".
            expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe(
                '# AGENTS\n\nbody\n',
            );
        }
    });

    it('repairs the broken "AGENTS.md" one-liner (the Windows breakage)', () => {
        const ws = makeTmpDir('claude-broken');
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# AGENTS\n\nreal instructions\n');
        fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'AGENTS.md'); // the broken pointer
        expect(classifyClaude(ws)).toBe('broken-pointer');
        const result = syncClaudeFromAgents(ws);
        expect(['symlinked', 'mirrored']).toContain(result);
        expect(['symlink', 'mirror']).toContain(classifyClaude(ws));
    });

    it('does NOT clobber a real, divergent CLAUDE.md — reports divergent', () => {
        const ws = makeTmpDir('claude-divergent');
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# AGENTS\n\ncanonical\n');
        fs.writeFileSync(
            path.join(ws, 'CLAUDE.md'),
            '# CLAUDE\n\nRicher, optimizer-written content.\n',
        );
        expect(classifyClaude(ws)).toBe('divergent');
        expect(syncClaudeFromAgents(ws)).toBe('divergent');
        // The divergent content is preserved untouched.
        expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe(
            '# CLAUDE\n\nRicher, optimizer-written content.\n',
        );
    });

    it('no-ops when AGENTS.md is absent', () => {
        const ws = makeTmpDir('claude-no-agents');
        expect(syncClaudeFromAgents(ws)).toBe('no-agents');
    });
});

describe('repairWorkspaceDocs', () => {
    const BEGIN = '<!-- BEGIN GENIE MCP (auto-managed by Genie) -->';

    it('scaffolds AGENTS.md, adds the Genie MCP section, and syncs CLAUDE.md', () => {
        const ws = makeTmpDir('repair-fresh');
        const r = repairWorkspaceDocs(ws, 'Demo', 'demo');
        const agents = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
        expect(agents).toContain(BEGIN); // Genie block present
        expect(r.health.hasAgents).toBe(true);
        expect(r.health.hasGenieSection).toBe(true);
        expect(['symlink', 'mirror']).toContain(r.health.claude);
        expect(r.claudeDivergent).toBe(false);
    });

    it('re-adds the Genie MCP block when it has been stripped (idempotent repair)', () => {
        const ws = makeTmpDir('repair-stripped');
        // An AGENTS.md WITHOUT the Genie block (e.g. an external rewrite).
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# AGENTS\n\nNo genie section here.\n');
        expect(workspaceDocHealth(ws).hasGenieSection).toBe(false);
        repairWorkspaceDocs(ws, 'Demo', 'demo');
        const agents = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
        expect(agents).toContain(BEGIN); // block re-added
        expect(agents).toContain('No genie section here.'); // original kept
        expect(workspaceDocHealth(ws).hasGenieSection).toBe(true);
    });

    it('reports (does not clobber) a divergent CLAUDE.md during repair', () => {
        const ws = makeTmpDir('repair-divergent');
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# AGENTS\n\ncanonical\n');
        fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# CLAUDE\n\nrich divergent\n');
        const r = repairWorkspaceDocs(ws, 'Demo', 'demo');
        expect(r.claudeDivergent).toBe(true);
        expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe(
            '# CLAUDE\n\nrich divergent\n',
        );
    });
});
