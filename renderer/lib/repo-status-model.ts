/**
 * PURE mapping from Genie's host `RepoStatus` (the `repo:status` IPC result) to
 * the `WorkingTreeStatus` the vetted `WorkingTree` (fancy-git-ui) renders. Kept
 * separate from the React adapter so the data shape is unit-testable.
 */
import type { ChangeKind, FileChange, WorkingTreeStatus } from '@particle-academy/fancy-git';
import type { RepoChangeLabel, RepoStatus } from './genie';

/**
 * Map a Genie change label to a fancy-git `ChangeKind`. fancy-git has no
 * 'typechange' kind, so a mode change reads as a modification.
 */
export function changeKind(label: RepoChangeLabel): ChangeKind {
    return label === 'typechange' ? 'modified' : label;
}

/** Build the `WorkingTree` view model from a Genie repo status. */
export function workingTreeStatusFrom(status: RepoStatus): WorkingTreeStatus {
    const files: FileChange[] = status.changes.map((c) => ({
        path: c.path,
        index: c.staged ? changeKind(c.label) : null,
        worktree: c.unstaged ? changeKind(c.label) : null,
    }));
    return {
        branch: status.branch,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        clean: status.changes.length === 0,
        files,
    };
}
