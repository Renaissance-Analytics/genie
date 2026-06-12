import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyseFolder } from '../analyse';
import { cleanupTmpRoot, makeTmpDir, seedGitRepo } from '../../../test/helpers';

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
