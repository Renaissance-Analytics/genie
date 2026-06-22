import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The Issue Watch SURFACED STATUS: a silent-empty workspace must explain WHY
 * (not connected / can't read / 404 / rate limited) rather than implying
 * "nothing open". We mock the db + git + github layers so a workspace resolves
 * to one repo, drive what `fetchRepoWatchItemsResult` returns, poll, and assert
 * the surfaced status + per-repo error.
 */

const WS = { id: 'ws-1', path: '/ws/demo.agi' };

// Mutable so each test drives what the (mocked) repo read returns.
let FETCH_RESULT: { items: unknown[]; error: string | null } = { items: [], error: null };
let TOKEN: string | null = 'tok';

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
}));
vi.mock('simple-git', () => ({
    default: () => ({
        getRemotes: async () => [
            { name: 'origin', refs: { fetch: 'git@github.com:o/r.git' } },
        ],
    }),
}));
vi.mock('../../db', () => ({
    getWorkspace: () => WS,
    listIssueWatches: () => [],
    listWorkspaces: () => [WS],
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
// worseError is a pure helper — re-implement its contract here so the mock
// doesn't drag the real electron/net world in via api.ts.
vi.mock('../../github/api', () => ({
    fetchRepoWatchItemsResult: async () => FETCH_RESULT,
    parseGitHubRemote: () => ({ owner: 'o', repo: 'r' }),
    worseError: (a: string | null, b: string | null) => {
        const RANK = ['unauthenticated', 'forbidden', 'not_found', 'rate_limited', 'unknown'];
        if (a === null) return b;
        if (b === null) return a;
        return RANK.indexOf(a) <= RANK.indexOf(b) ? a : b;
    },
}));
vi.mock('../../github/storage', () => ({ getToken: () => TOKEN }));

import {
    getWorkspaceStatus,
    getWorkspaceRepoViews,
    pollWorkspace,
    worstViewError,
} from '../index';

beforeEach(() => {
    FETCH_RESULT = { items: [], error: null };
    TOKEN = 'tok';
});

describe('getWorkspaceStatus', () => {
    it('reports not connected when there is no GitHub token', async () => {
        TOKEN = null;
        expect(await getWorkspaceStatus('ws-1')).toEqual({ connected: false, error: null });
    });

    it('reports a clean success (connected, no error) after a good poll', async () => {
        FETCH_RESULT = { items: [], error: null };
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toEqual({ connected: true, error: null });
    });

    it('surfaces a forbidden read so the empty feed explains itself', async () => {
        FETCH_RESULT = { items: [], error: 'forbidden' };
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: true,
            error: 'forbidden',
        });
    });

    it('surfaces a not_found read', async () => {
        FETCH_RESULT = { items: [], error: 'not_found' };
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: true,
            error: 'not_found',
        });
    });
});

describe('getWorkspaceRepoViews (per-repo error)', () => {
    it('carries the per-repo read error onto the view', async () => {
        FETCH_RESULT = { items: [], error: 'forbidden' };
        await pollWorkspace('ws-1');
        const views = await getWorkspaceRepoViews('ws-1');
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ owner: 'o', repo: 'r', enabled: true, error: 'forbidden' });
    });
});

describe('worstViewError', () => {
    it('is null when every enabled repo read succeeded', () => {
        expect(
            worstViewError([
                { owner: 'o', repo: 'a', enabled: true, unread: 0, error: null },
                { owner: 'o', repo: 'b', enabled: true, unread: 0, error: null },
            ]),
        ).toBeNull();
    });

    it('returns the worst error across enabled repos and ignores disabled ones', () => {
        expect(
            worstViewError([
                { owner: 'o', repo: 'a', enabled: true, unread: 0, error: 'not_found' },
                { owner: 'o', repo: 'b', enabled: true, unread: 0, error: 'forbidden' },
                { owner: 'o', repo: 'c', enabled: false, unread: 0, error: 'unauthenticated' },
            ]),
        ).toBe('forbidden');
    });
});
