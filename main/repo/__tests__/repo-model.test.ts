import path from 'path';
import { describe, expect, it } from 'vitest';
import {
    classifyChange,
    parseBranchLine,
    parseRepoStatus,
    guardRepoPath,
    repoRefsFromProjectJson,
} from '../model';

/**
 * Pure git-model helpers for the Repository panel: classify a porcelain XY pair,
 * parse the `--branch` header (branch / upstream / ahead / behind / detached),
 * parse the whole `git status --porcelain=v1 --branch` output into the panel's
 * view model, and contain a repo path within its workspace root. These are the
 * TDD core; the simple-git I/O around them is thin.
 */

describe('classifyChange', () => {
    it('labels the common XY pairs', () => {
        expect(classifyChange('?', '?')).toBe('untracked');
        expect(classifyChange('A', ' ')).toBe('added');
        expect(classifyChange(' ', 'M')).toBe('modified');
        expect(classifyChange('M', ' ')).toBe('modified');
        expect(classifyChange('D', ' ')).toBe('deleted');
        expect(classifyChange(' ', 'D')).toBe('deleted');
        expect(classifyChange('R', ' ')).toBe('renamed');
        expect(classifyChange('C', ' ')).toBe('copied');
        expect(classifyChange('T', ' ')).toBe('typechange');
        expect(classifyChange('U', 'U')).toBe('conflicted');
    });
});

describe('parseBranchLine', () => {
    it('parses branch + upstream + ahead/behind', () => {
        expect(parseBranchLine('## main...origin/main [ahead 2, behind 1]')).toEqual({
            branch: 'main',
            upstream: 'origin/main',
            ahead: 2,
            behind: 1,
            detached: false,
        });
    });

    it('parses ahead only', () => {
        expect(parseBranchLine('## feat/x...origin/feat/x [ahead 3]')).toEqual({
            branch: 'feat/x',
            upstream: 'origin/feat/x',
            ahead: 3,
            behind: 0,
            detached: false,
        });
    });

    it('parses a branch with an upstream but no divergence', () => {
        expect(parseBranchLine('## main...origin/main')).toEqual({
            branch: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
        });
    });

    it('parses a branch with no upstream', () => {
        expect(parseBranchLine('## solo')).toEqual({
            branch: 'solo',
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        });
    });

    it('parses a fresh repo with no commits yet', () => {
        const r = parseBranchLine('## No commits yet on main');
        expect(r.branch).toBe('main');
        expect(r.upstream).toBeNull();
    });

    it('marks a detached HEAD', () => {
        const r = parseBranchLine('## HEAD (no branch)');
        expect(r.detached).toBe(true);
        expect(r.branch).toBeNull();
    });
});

describe('parseRepoStatus', () => {
    it('parses the branch header + changed files into the panel view model', () => {
        const stdout = [
            '## main...origin/main [ahead 1]',
            'M  staged-mod.ts',
            ' M unstaged-mod.ts',
            'A  new-staged.ts',
            '?? untracked.txt',
            'MM both.ts',
        ].join('\n');
        const st = parseRepoStatus(stdout);
        expect(st.branch).toBe('main');
        expect(st.ahead).toBe(1);
        expect(st.behind).toBe(0);
        const byPath = Object.fromEntries(st.changes.map((c) => [c.path, c]));
        expect(byPath['staged-mod.ts']).toMatchObject({ staged: true, unstaged: false, label: 'modified' });
        expect(byPath['unstaged-mod.ts']).toMatchObject({ staged: false, unstaged: true, label: 'modified' });
        expect(byPath['new-staged.ts']).toMatchObject({ staged: true, label: 'added' });
        expect(byPath['untracked.txt']).toMatchObject({ untracked: true, unstaged: true, label: 'untracked' });
        // MM = staged AND unstaged modifications on the same file.
        expect(byPath['both.ts']).toMatchObject({ staged: true, unstaged: true });
    });

    it('records the NEW path for a rename', () => {
        const st = parseRepoStatus(['## main', 'R  old.ts -> new.ts'].join('\n'));
        expect(st.changes.map((c) => c.path)).toContain('new.ts');
        expect(st.changes[0].label).toBe('renamed');
        expect(st.changes[0].staged).toBe(true);
    });

    it('is empty for a clean tree (header only)', () => {
        const st = parseRepoStatus('## main...origin/main');
        expect(st.changes).toEqual([]);
    });
});

describe('guardRepoPath', () => {
    const root = path.resolve('/ws/root');

    it('resolves a repo-relative path inside the workspace root', () => {
        expect(guardRepoPath(root, 'repos/tynn')).toBe(path.join(root, 'repos/tynn'));
    });

    it('treats an empty rel path as the workspace root itself', () => {
        expect(guardRepoPath(root, '')).toBe(root);
        expect(guardRepoPath(root, '.')).toBe(root);
    });

    it('rejects a path that escapes the workspace root', () => {
        expect(() => guardRepoPath(root, '../evil')).toThrow();
        expect(() => guardRepoPath(root, 'repos/../../evil')).toThrow();
    });

    it('rejects an absolute repo path', () => {
        expect(() => guardRepoPath(root, path.resolve('/etc'))).toThrow();
    });
});

describe('repoRefsFromProjectJson', () => {
    it('lists the root then each member repo that is a git work tree', () => {
        const refs = repoRefsFromProjectJson(
            'tynn.ai',
            [
                { name: 'tynn', path: 'repos/tynn' },
                { name: 'genie', path: 'repos/genie' },
                { name: 'not-cloned', path: 'repos/not-cloned' },
            ],
            (rel) => rel === '' || rel === 'repos/tynn' || rel === 'repos/genie',
        );
        expect(refs).toEqual([
            { rel: '', name: 'tynn.ai' },
            { rel: 'repos/tynn', name: 'tynn' },
            { rel: 'repos/genie', name: 'genie' },
        ]);
    });

    it('omits the root when it is not a git repo', () => {
        const refs = repoRefsFromProjectJson('ws', [{ name: 'a', path: 'repos/a' }], (rel) => rel === 'repos/a');
        expect(refs).toEqual([{ rel: 'repos/a', name: 'a' }]);
    });

    it('returns just the root for a plain (non-envelope) git workspace', () => {
        expect(repoRefsFromProjectJson('myrepo', undefined, (rel) => rel === '')).toEqual([
            { rel: '', name: 'myrepo' },
        ]);
    });
});
