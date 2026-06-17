import { describe, expect, it, vi, beforeEach } from 'vitest';

// Verify getUnreadCounts counts DEFAULT-ON repos (auto-detected, no persisted
// issue_watches row) — the alpha.70 fix. We mock the db + git + github layers
// so a workspace resolves to one repo with no row, prime its feed via the
// poller, then assert the workspace's pill counts go non-zero.

const WS = { id: 'ws-1', path: '/ws/demo.agi' };

// One open issue + one open PR, both newer than the epoch → both unread when
// the repo has no seen_at row.
const ITEMS = [
    { kind: 'issue', key: 'o/r#1', number: 1, title: 'i', url: 'u', updatedAt: '2026-06-16T10:00:00.000Z' },
    { kind: 'pr', key: 'o/r#2', number: 2, title: 'p', url: 'u', updatedAt: '2026-06-16T11:00:00.000Z' },
];

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
}));
// resolveWorkspaceRepos reads remotes via simple-git, then parseGitHubRemote.
vi.mock('simple-git', () => ({
    default: () => ({
        getRemotes: async () => [
            { name: 'origin', refs: { fetch: 'git@github.com:o/r.git' } },
        ],
    }),
}));
vi.mock('../../db', () => ({
    getWorkspace: () => WS,
    listIssueWatches: () => [], // NO persisted rows → default-on path
    listWorkspaces: () => [WS],
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
}));
// detectFolder returns no sub-repos → the workspace path itself is the repo.
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../github/api', () => ({
    fetchRepoWatchItems: async () => ITEMS,
    parseGitHubRemote: () => ({ owner: 'o', repo: 'r' }),
}));
// A truthy token so the poller actually fetches + fills the feed cache.
vi.mock('../../github/storage', () => ({ getToken: () => 'tok' }));

import { getUnreadCounts, pollWorkspace } from '../index';

describe('getUnreadCounts — default-on repos', () => {
    beforeEach(async () => {
        // Prime feedCache for the workspace's default-on repo.
        await pollWorkspace('ws-1');
    });

    it('counts a default-on repo (no persisted row) so the pill lights up', async () => {
        const counts = await getUnreadCounts();
        expect(counts['ws-1']).toEqual({ issue: 1, pr: 1, dependabot: 0 });
    });
});
