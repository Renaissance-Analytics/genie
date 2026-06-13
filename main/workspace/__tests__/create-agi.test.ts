import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import {
    convertToAgi,
    createAgiEnvelope,
    deriveRepoName,
    envelopeFolderName,
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
