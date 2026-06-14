import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitStatus, parseGitPorcelain } from '../ipc';
import { cleanupTmpRoot, makeTmpDir, seedGitRepo } from '../../../test/helpers';
import { simpleGit } from 'simple-git';

afterAll(() => cleanupTmpRoot());

describe('parseGitPorcelain', () => {
    it('classifies untracked / modified / staged / deleted', () => {
        const out = [
            '?? new.txt', // untracked
            ' M edited.txt', // modified (worktree)
            'M  staged-mod.txt', // modified, staged
            'A  added.txt', // added/staged
            ' D gone.txt', // deleted (worktree)
            'D  removed.txt', // deleted (index)
            'MM both.txt', // staged + worktree mod → modified
        ].join('\n');
        const map = parseGitPorcelain(out);
        expect(map['new.txt']).toBe('untracked');
        expect(map['edited.txt']).toBe('modified');
        expect(map['staged-mod.txt']).toBe('modified');
        expect(map['added.txt']).toBe('added');
        expect(map['gone.txt']).toBe('deleted');
        expect(map['removed.txt']).toBe('deleted');
        expect(map['both.txt']).toBe('modified');
    });

    it('classifies ignored entries', () => {
        const map = parseGitPorcelain('!! node_modules/\n!! dist/bundle.js');
        expect(map['node_modules/']).toBe('ignored');
        expect(map['dist/bundle.js']).toBe('ignored');
    });

    it('records the NEW path for a `R old -> new` rename line', () => {
        const map = parseGitPorcelain('R  old-name.txt -> new-name.txt');
        expect(map['new-name.txt']).toBe('renamed');
        // The old path is not recorded (it no longer exists on disk).
        expect(map['old-name.txt']).toBeUndefined();
    });

    it('handles quoted paths with spaces (quotepath form)', () => {
        // git quotes paths with spaces/specials when core.quotepath is on.
        const map = parseGitPorcelain('?? "a file with spaces.txt"');
        expect(map['a file with spaces.txt']).toBe('untracked');
    });

    it('handles a rename whose new path has spaces', () => {
        const map = parseGitPorcelain('R  "old one.txt" -> "new two.txt"');
        expect(map['new two.txt']).toBe('renamed');
    });

    it('forward-slashes backslashed paths and skips blank lines', () => {
        const map = parseGitPorcelain(' M src\\deep\\a.ts\n\n');
        expect(map['src/deep/a.ts']).toBe('modified');
    });
});

describe('files:git-status (real repo)', () => {
    it('returns an empty map for a non-git directory (never throws)', async () => {
        const dir = makeTmpDir('gs-nongit');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
        const map = await gitStatus(dir);
        expect(map).toEqual({});
    });

    it('reports untracked, modified, staged-added, and deleted files', async () => {
        const dir = makeTmpDir('gs-repo');
        // seedGitRepo makes an initial commit with README.md.
        await seedGitRepo(dir);
        const git = simpleGit(dir);

        // Commit a file we'll later delete (so the deletion is vs HEAD).
        fs.writeFileSync(path.join(dir, 'doomed.txt'), 'bye');
        await git.add('doomed.txt');
        await git.commit(['-m', 'add doomed', 'doomed.txt']);

        // Untracked new file.
        fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new');
        // Modify the committed README.
        fs.writeFileSync(path.join(dir, 'README.md'), '# changed\n');
        // Delete the committed file.
        fs.rmSync(path.join(dir, 'doomed.txt'));
        // Staged-added file (staged LAST so nothing re-commits it).
        fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged');
        await git.add('staged.txt');

        const map = await gitStatus(dir);
        expect(map['untracked.txt']).toBe('untracked');
        expect(map['README.md']).toBe('modified');
        expect(map['staged.txt']).toBe('added');
        expect(map['doomed.txt']).toBe('deleted');
    });

    it('reports a renamed file at its new path', async () => {
        const dir = makeTmpDir('gs-rename');
        await seedGitRepo(dir);
        const git = simpleGit(dir);
        fs.writeFileSync(path.join(dir, 'orig.txt'), 'content here\n');
        await git.add('orig.txt');
        await git.commit('add orig');
        // Rename via git so the index records a rename.
        await git.mv('orig.txt', 'renamed.txt');

        const map = await gitStatus(dir);
        expect(map['renamed.txt']).toBe('renamed');
    });

    it('handles a path containing spaces', async () => {
        const dir = makeTmpDir('gs-spaces');
        await seedGitRepo(dir);
        fs.writeFileSync(path.join(dir, 'a file with spaces.txt'), 'x');
        const map = await gitStatus(dir);
        expect(map['a file with spaces.txt']).toBe('untracked');
    });

    it('lists ignored files only when opts.ignored is set', async () => {
        const dir = makeTmpDir('gs-ignored');
        await seedGitRepo(dir);
        fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n');
        fs.writeFileSync(path.join(dir, 'ignored.log'), 'noise');

        const without = await gitStatus(dir);
        expect(without['ignored.log']).toBeUndefined();

        const withIgnored = await gitStatus(dir, { ignored: true });
        expect(withIgnored['ignored.log']).toBe('ignored');
    });
});
