import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import {
    addStructureDocs,
    consolidateMcpAndCommit,
    convertToAgi,
    createAgiEnvelope,
    deriveRepoName,
    envelopeFolderName,
    structureDocStatus,
} from '../create-agi';
import { cleanupTmpRoot, makeTmpDir, seedGitRepo } from '../../../test/helpers';

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
