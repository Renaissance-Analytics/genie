import { describe, expect, it } from 'vitest';
import { changeKind, workingTreeStatusFrom } from '../repo-status-model';
import type { RepoStatus } from '../genie';

/**
 * Pure mapping from Genie's host `RepoStatus` (from `repo:status`) to the
 * `WorkingTreeStatus` the vetted fancy-git-ui `WorkingTree` renders. Testable
 * without React so the adapter's data shape is pinned.
 */

function status(over: Partial<RepoStatus> = {}): RepoStatus {
    return {
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        detached: false,
        changes: [],
        ...over,
    };
}

describe('changeKind', () => {
    it('passes fancy-git ChangeKinds through', () => {
        expect(changeKind('added')).toBe('added');
        expect(changeKind('modified')).toBe('modified');
        expect(changeKind('untracked')).toBe('untracked');
        expect(changeKind('renamed')).toBe('renamed');
    });

    it('maps typechange (which fancy-git has no kind for) to modified', () => {
        expect(changeKind('typechange')).toBe('modified');
    });
});

describe('workingTreeStatusFrom', () => {
    it('carries the branch header and clean flag', () => {
        expect(workingTreeStatusFrom(status())).toMatchObject({
            branch: 'main',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
            clean: true,
            files: [],
        });
    });

    it('splits staged vs unstaged onto the index/worktree sides', () => {
        const wt = workingTreeStatusFrom(
            status({
                changes: [
                    { path: 'a.ts', index: 'M', worktree: ' ', staged: true, unstaged: false, untracked: false, label: 'modified' },
                    { path: 'b.ts', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, label: 'modified' },
                    { path: 'c.txt', index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, label: 'untracked' },
                ],
            }),
        );
        expect(wt.clean).toBe(false);
        expect(wt.files).toEqual([
            { path: 'a.ts', index: 'modified', worktree: null },
            { path: 'b.ts', index: null, worktree: 'modified' },
            { path: 'c.txt', index: null, worktree: 'untracked' },
        ]);
    });
});
