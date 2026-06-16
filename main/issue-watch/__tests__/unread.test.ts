import { describe, expect, it, vi } from 'vitest';

// Isolate the pure helper — index.ts imports electron/db/simple-git/github at
// module load; stub them so importing unreadCount doesn't drag the world in.
vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
}));
vi.mock('simple-git', () => ({ default: () => ({ getRemotes: async () => [] }) }));
vi.mock('../../db', () => ({
    getWorkspace: () => null,
    listIssueWatches: () => [],
    listEnabledIssueWatches: () => [],
    listWorkspaces: () => [],
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../github/api', () => ({
    fetchRepoWatchItems: async () => [],
    parseGitHubRemote: () => null,
}));
vi.mock('../../github/storage', () => ({ getToken: () => null }));

import { unreadCount } from '../index';
import type { WatchItem } from '../../github/api';

const item = (key: string, updatedAt: string): WatchItem => ({
    kind: 'issue',
    key,
    number: 1,
    title: key,
    url: 'https://github.com/o/r/issues/1',
    updatedAt,
});

describe('unreadCount', () => {
    it('counts items updated strictly after the seen-at mark', () => {
        const items = [
            item('a', '2026-06-16T10:00:00.000Z'),
            item('b', '2026-06-16T12:00:00.000Z'),
            item('c', '2026-06-16T09:00:00.000Z'),
        ];
        expect(unreadCount(items, '2026-06-16T11:00:00.000Z')).toBe(1); // only b
    });

    it('treats equal/older timestamps as seen', () => {
        expect(unreadCount([item('a', '2026-06-16T08:00:00.000Z')], '2026-06-16T08:00:00.000Z')).toBe(0);
        expect(unreadCount([], '2026-06-16T08:00:00.000Z')).toBe(0);
    });

    it('counts everything against the epoch default', () => {
        const items = [
            item('a', '2026-01-01T00:00:00.000Z'),
            item('b', '2026-02-01T00:00:00.000Z'),
        ];
        expect(unreadCount(items, '1970-01-01T00:00:00.000Z')).toBe(2);
    });
});
