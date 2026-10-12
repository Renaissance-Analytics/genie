import { describe, expect, it } from 'vitest';
import { branchFromHead, lockState, repoChip, STALE_LOCK_AFTER_MS } from '../src/core/repo-status.js';

/**
 * THE WORKSPACE HEADER'S REPO CHIPS (the board: `api · main` with a git-branch icon; a red `web · index.lock held`
 * with "Remove stale lock"). Read from `.git` directly — `HEAD` names the branch, `index.lock` is the lock — with no
 * library and no guess: a detached HEAD is the short sha, a repo Genie cannot read has no branch (null), and a lock
 * is STALE only once it has sat longer than any real git command takes.
 */
describe('branchFromHead', () => {
    it('reads the branch from a symbolic HEAD; a detached HEAD is the short sha; garbage is null', () => {
        expect(branchFromHead('ref: refs/heads/main\n')).toBe('main');
        expect(branchFromHead('ref: refs/heads/feature/x-1')).toBe('feature/x-1');
        expect(branchFromHead('9e1c2af0b3c4d5e6f708192a3b4c5d6e7f8091a2\n')).toBe('9e1c2af');
        expect(branchFromHead('')).toBeNull();
        expect(branchFromHead(null)).toBeNull();
    });
});

describe('lockState', () => {
    it('no lock file → null; a fresh lock → held, not stale; an old lock → held and stale', () => {
        expect(lockState(null, 100_000)).toBeNull();
        expect(lockState(99_000, 100_000)).toEqual({ heldSince: 99_000, stale: false });
        expect(lockState(100_000 - STALE_LOCK_AFTER_MS - 1, 100_000)).toEqual({ heldSince: 100_000 - STALE_LOCK_AFTER_MS - 1, stale: true });
    });
});

describe('repoChip', () => {
    it('`slug · branch` in the normal case; `slug · index.lock held` in red with the fix only when the lock is stale', () => {
        expect(repoChip({ slug: 'api', branch: 'main', lock: null })).toEqual({ label: 'api · main', tone: 'normal', fix: null });
        expect(repoChip({ slug: 'web', branch: 'main', lock: { heldSince: 1, stale: true } })).toEqual({ label: 'web · index.lock held', tone: 'bad', fix: 'Remove stale lock' });
        // A FRESH lock is a git command in flight — said, not offered for removal.
        expect(repoChip({ slug: 'web', branch: 'main', lock: { heldSince: 1, stale: false } })).toEqual({ label: 'web · index.lock held', tone: 'bad', fix: null });
        // No branch read → the slug alone, never a dash.
        expect(repoChip({ slug: 'docs', branch: null, lock: null })).toEqual({ label: 'docs', tone: 'normal', fix: null });
    });
});
