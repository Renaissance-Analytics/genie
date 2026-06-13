import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { analyseFolder, parseGitModulesText } from '../analyse';
import { cleanupTmpRoot, makeTmpDir, seedGitRepo } from '../../../test/helpers';

const execFileAsync = promisify(execFile);

afterAll(() => cleanupTmpRoot());

describe('analyseFolder source classification', () => {
    it('classifies a root git repo as single-repo with one root candidate', async () => {
        const dir = makeTmpDir('an-single');
        await seedGitRepo(dir);

        const r = await analyseFolder(dir);
        expect(r.source_kind).toBe('single-repo');
        expect(r.repos).toHaveLength(1);
        expect(r.repos[0].rel_path).toBe('.');
        expect(r.repos[0].abs_path).toBe(dir);
    });

    it('classifies a folder of repos as repo-collection', async () => {
        const dir = makeTmpDir('an-collection');
        const a = path.join(dir, 'app');
        const b = path.join(dir, 'lib');
        fs.mkdirSync(a);
        fs.mkdirSync(b);
        await seedGitRepo(a);
        await seedGitRepo(b);

        const r = await analyseFolder(dir);
        expect(r.source_kind).toBe('repo-collection');
        expect(r.repos.map((x) => x.rel_path).sort()).toEqual(['app', 'lib']);
        expect(r.root_entries).toBeUndefined();
    });

    it('classifies a gitless folder as plain-folder', async () => {
        const dir = makeTmpDir('an-plain');
        fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n');

        const r = await analyseFolder(dir);
        expect(r.source_kind).toBe('plain-folder');
        expect(r.repos).toHaveLength(0);
    });

    it('single-repo: nested repos are NOT separate candidates', async () => {
        const dir = makeTmpDir('an-nested');
        await seedGitRepo(dir);
        const nested = path.join(dir, 'third-party');
        fs.mkdirSync(nested);
        await seedGitRepo(nested);

        const r = await analyseFolder(dir);
        expect(r.source_kind).toBe('single-repo');
        expect(r.repos).toHaveLength(1);
        expect(r.repos[0].rel_path).toBe('.');
    });

    it('single-repo has empty submodules array', async () => {
        const dir = makeTmpDir('an-single-subs');
        await seedGitRepo(dir);
        const r = await analyseFolder(dir);
        expect(r.source_kind).toBe('single-repo');
        expect(r.submodules).toEqual([]);
    });

    it('classifies a root repo WITH git submodules as monorepo', async () => {
        // Root repo plus two local repos added as real submodules.
        const dir = makeTmpDir('an-mono');
        await seedGitRepo(dir);
        const subA = makeTmpDir('an-mono-subA');
        const subB = makeTmpDir('an-mono-subB');
        await seedGitRepo(subA);
        await seedGitRepo(subB);

        // Local-path submodule adds need protocol.file.allow=always (CVE-2022-39253).
        const addSub = (url: string, p: string) =>
            execFileAsync(
                'git',
                ['-c', 'protocol.file.allow=always', 'submodule', 'add', url, p],
                { cwd: dir, maxBuffer: 32 * 1024 * 1024 },
            );
        await addSub(subA, 'repos/alpha');
        await addSub(subB, 'repos/beta');

        const r = await analyseFolder(dir);
        expect(r.source_kind).toBe('monorepo');
        expect(r.submodules).toHaveLength(2);

        const byPath = new Map(r.submodules.map((s) => [s.path, s]));
        const alpha = byPath.get('repos/alpha')!;
        expect(alpha).toBeDefined();
        expect(alpha.name).toBe('repos/alpha');
        expect(alpha.url).toBe(subA);
        const beta = byPath.get('repos/beta')!;
        expect(beta).toBeDefined();
        expect(beta.url).toBe(subB);

        // root_entries still populated (root is a repo).
        expect(r.root_entries).toBeDefined();
    });

    it('parseGitModulesText handles the standard INI-ish format', () => {
        const text = [
            '# a comment',
            '[submodule "fancy-ui"]',
            '\tpath = repos/fancy-ui',
            '\turl = git@github.com:org/fancy-ui.git',
            '[submodule "brain"]',
            '    path = repos/brain',
            '    url = https://github.com/org/brain.git',
            // Incomplete entry (no url) is dropped.
            '[submodule "dangling"]',
            '    path = repos/dangling',
        ].join('\n');
        const subs = parseGitModulesText(text);
        expect(subs).toHaveLength(2);
        expect(subs.map((s) => s.name).sort()).toEqual(['brain', 'fancy-ui']);
        const fancy = subs.find((s) => s.name === 'fancy-ui')!;
        expect(fancy.path).toBe('repos/fancy-ui');
        expect(fancy.url).toBe('git@github.com:org/fancy-ui.git');
    });
});

describe('single-repo root entry dispositions', () => {
    it('marks tracked/untracked/ignored via the local git store', async () => {
        const dir = makeTmpDir('an-disp');
        await seedGitRepo(dir); // commits README.md

        // Ignored knowledge dir + the ignore rule itself (committed).
        fs.writeFileSync(path.join(dir, '.gitignore'), '.ai/\ndebug.log\n');
        fs.mkdirSync(path.join(dir, '.ai'));
        fs.writeFileSync(path.join(dir, '.ai', 'plan.md'), 'plan\n');
        // Untracked loose file.
        fs.writeFileSync(path.join(dir, 'todo.md'), 'todo\n');
        // Ignored non-knowledge file (.log is not a knowledge extension).
        fs.writeFileSync(path.join(dir, 'debug.log'), 'wip\n');
        const { simpleGit } = await import('simple-git');
        const git = simpleGit(dir);
        await git.add('.gitignore');
        await git.commit('add ignore rules');

        const r = await analyseFolder(dir);
        const byName = new Map(r.root_entries!.map((e) => [e.rel_path, e]));

        expect(byName.get('README.md')!.git_state).toBe('tracked');
        expect(byName.get('README.md')!.suggested).toBe('codebase');

        expect(byName.get('.ai')!.git_state).toBe('ignored');
        // Ignored knowledge-shaped dir → suggested copy into .ai/ root.
        expect(byName.get('.ai')!.suggested).toBe('knowledge');

        expect(byName.get('todo.md')!.git_state).toBe('untracked');
        // Untracked markdown is knowledge-shaped → suggested knowledge.
        expect(byName.get('todo.md')!.suggested).toBe('knowledge');

        expect(byName.get('debug.log')!.git_state).toBe('ignored');
        // Not knowledge-shaped → defaults to codebase (user can flip).
        expect(byName.get('debug.log')!.suggested).toBe('codebase');
    });
});
