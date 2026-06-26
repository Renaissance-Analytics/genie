import { describe, expect, it, vi, beforeEach } from 'vitest';

// Verify the workspace pill counts (getOpenCounts) signal PRESENCE — green
// whenever the workspace's watched repos have open items of a type, regardless
// of seen state — and cover DEFAULT-ON repos (auto-detected, no persisted
// issue_watches row). We mock the db + git + github layers so a workspace
// resolves to one repo, prime its feed via the poller, then assert counts.

const WS = { id: 'ws-1', path: '/ws/demo.agi' };

// One open issue + one open PR. Mutable so a test can swap in security items
// (which aggregate into the single `security` bucket) before re-polling.
let ITEMS: Array<{
    kind: string;
    key: string;
    number: number;
    title: string;
    url: string;
    updatedAt: string;
}> = [
    { kind: 'issue', key: 'o/r#1', number: 1, title: 'i', url: 'u', updatedAt: '2026-06-16T10:00:00.000Z' },
    { kind: 'pr', key: 'o/r#2', number: 2, title: 'p', url: 'u', updatedAt: '2026-06-16T11:00:00.000Z' },
];
const DEFAULT_ITEMS = ITEMS;

// Mutable so a test can simulate a persisted row whose seen_at is AFTER every
// item (i.e. "everything seen") — presence counting must still report green.
let WATCHES: Array<{ owner: string; repo: string; enabled: number; seen_at: string }> = [];

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
    listIssueWatches: () => WATCHES,
    listWorkspaces: () => [WS],
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
}));
// detectFolder returns no sub-repos → the workspace path itself is the repo.
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../github/api', () => ({
    fetchRepoWatchItems: async () => ITEMS,
    // pollRepo now reads the OUTCOME shape (items + read error) so a
    // silent-empty feed can explain itself; a clean read = null error.
    fetchRepoWatchItemsResult: async () => ({ items: ITEMS, error: null }),
    parseGitHubRemote: () => ({ owner: 'o', repo: 'r' }),
    worseError: (a: string | null, b: string | null) => a ?? b,
    // countByKind/getOpenCounts bucket the three security kinds into `security`.
    isSecurityKind: (kind: string) =>
        kind === 'dependabot' || kind === 'code-scanning' || kind === 'secret-scanning',
}));
// A truthy token so the poller actually fetches + fills the feed cache.
vi.mock('../../github/storage', () => ({ getToken: () => 'tok' }));

import { getOpenCounts, countByKind, pollWorkspace } from '../index';
import type { WatchItem } from '../../github/api';

describe('getOpenCounts — presence of open items', () => {
    beforeEach(async () => {
        WATCHES = [];
        ITEMS = DEFAULT_ITEMS;
        await pollWorkspace('ws-1'); // prime feedCache for the default-on repo
    });

    it('counts a default-on repo (no persisted row) so the pill lights up', async () => {
        const counts = await getOpenCounts();
        expect(counts['ws-1']).toEqual({ issue: 1, pr: 1, security: 0 });
    });

    it('aggregates the three security kinds into one security bucket', async () => {
        // One of each security stream + an issue → security:3, issue:1, pr:0.
        ITEMS = [
            { kind: 'issue', key: 'o/r#1', number: 1, title: 'i', url: 'u', updatedAt: '2026-06-16T10:00:00.000Z' },
            { kind: 'dependabot', key: 'o/r:dep:1', number: 5, title: 'dep', url: 'u', updatedAt: '2026-06-16T11:00:00.000Z' },
            { kind: 'code-scanning', key: 'o/r:cs:1', number: 6, title: 'cs', url: 'u', updatedAt: '2026-06-16T12:00:00.000Z' },
            { kind: 'secret-scanning', key: 'o/r:ss:1', number: 7, title: 'ss', url: 'u', updatedAt: '2026-06-16T13:00:00.000Z' },
        ];
        await pollWorkspace('ws-1'); // re-prime the feed cache with the security items
        const counts = await getOpenCounts();
        expect(counts['ws-1']).toEqual({ issue: 1, pr: 0, security: 3 });
    });

    it('stays green even when everything is already seen (presence, not unread)', async () => {
        // A persisted row whose seen_at is AFTER every item → 0 unread, but the
        // items are still OPEN, so the dot must stay green.
        WATCHES = [{ owner: 'o', repo: 'r', enabled: 1, seen_at: '2999-01-01T00:00:00.000Z' }];
        const counts = await getOpenCounts();
        expect(counts['ws-1']).toEqual({ issue: 1, pr: 1, security: 0 });
    });

    it('drops the workspace entirely when the repo is disabled', async () => {
        WATCHES = [{ owner: 'o', repo: 'r', enabled: 0, seen_at: '1970-01-01T00:00:00.000Z' }];
        const counts = await getOpenCounts();
        expect(counts['ws-1']).toBeUndefined();
    });
});

describe('countByKind', () => {
    const item = (kind: WatchItem['kind'], updatedAt: string): WatchItem => ({
        kind,
        key: `${kind}-${updatedAt}`,
        number: 1,
        title: kind,
        url: 'u',
        updatedAt,
    });

    it('counts ALL items by bucket, aggregating the three security kinds', () => {
        const items = [
            item('issue', '2026-01-01T00:00:00.000Z'),
            item('issue', '2026-02-01T00:00:00.000Z'),
            item('pr', '2026-03-01T00:00:00.000Z'),
            // All three security streams collapse into the single security bucket.
            item('dependabot', '2020-01-01T00:00:00.000Z'), // ancient → still counts
            item('code-scanning', '2026-04-01T00:00:00.000Z'),
            item('secret-scanning', '2026-05-01T00:00:00.000Z'),
        ];
        expect(countByKind(items)).toEqual({ issue: 2, pr: 1, security: 3 });
    });

    it('is zero for an empty list', () => {
        expect(countByKind([])).toEqual({ issue: 0, pr: 0, security: 0 });
    });
});
