import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The Issue Watch SURFACED STATUS: a silent-empty workspace must explain WHY
 * (not connected / can't read / 404 / rate limited) rather than implying
 * "nothing open". We mock the db + git + github layers so a workspace resolves
 * to one repo, drive what `fetchRepoWatchItemsResult` returns, poll, and assert
 * the surfaced status + per-repo error.
 */

const WS = { id: 'ws-1', path: '/ws/demo.agi' };

// Mutable so each test drives what the (mocked) repo read returns. `detail`
// mirrors the real FetchOutcome (bucket + raw status/message); the index pulls
// `error` off `detail`, so the two stay consistent.
type Detail = { error: string; status?: number; message?: string };
let FETCH_RESULT: { items: unknown[]; error: string | null; detail: Detail | null } = {
    items: [],
    error: null,
    detail: null,
};
let TOKEN: string | null = 'tok';
let NEEDS_REAUTH = false;

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
vi.mock('../../github/storage', () => ({
    getToken: () => TOKEN,
    needsReauth: () => NEEDS_REAUTH,
}));

import {
    getWorkspaceStatus,
    getWorkspaceRepoViews,
    pollWorkspace,
    worstViewError,
    worstViewDetail,
} from '../index';

beforeEach(() => {
    FETCH_RESULT = { items: [], error: null, detail: null };
    TOKEN = 'tok';
    NEEDS_REAUTH = false;
});

describe('getWorkspaceStatus', () => {
    it('reports not connected when there is no GitHub token', async () => {
        TOKEN = null;
        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: false,
            error: null,
            detail: null,
            needsReauth: false,
        });
    });

    it('flags reconnect when there is no token but the session was flagged dead', async () => {
        TOKEN = null;
        NEEDS_REAUTH = true;
        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: false,
            error: null,
            detail: null,
            needsReauth: true,
        });
    });

    it('reports a clean success (connected, no error) after a good poll', async () => {
        FETCH_RESULT = { items: [], error: null, detail: null };
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: true,
            error: null,
            detail: null,
            needsReauth: false,
        });
    });

    it('surfaces a forbidden read WITH its precise status/message', async () => {
        FETCH_RESULT = {
            items: [],
            error: 'forbidden',
            detail: { error: 'forbidden', status: 403, message: 'Resource not accessible' },
        };
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: true,
            error: 'forbidden',
            detail: { error: 'forbidden', status: 403, message: 'Resource not accessible' },
            needsReauth: false,
        });
    });

    it('surfaces a not_found read', async () => {
        FETCH_RESULT = {
            items: [],
            error: 'not_found',
            detail: { error: 'not_found', status: 404, message: 'Not Found' },
        };
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toMatchObject({
            connected: true,
            error: 'not_found',
        });
    });

    it('marks needsReauth on an unauthenticated (401) read so the flyout offers Reconnect', async () => {
        FETCH_RESULT = {
            items: [],
            error: 'unauthenticated',
            detail: { error: 'unauthenticated', status: 401, message: 'Bad credentials' },
        };
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: true,
            error: 'unauthenticated',
            detail: { error: 'unauthenticated', status: 401, message: 'Bad credentials' },
            needsReauth: true,
        });
    });

    it('marks needsReauth when the stored session was flagged dead even if reads look clean', async () => {
        FETCH_RESULT = { items: [], error: null, detail: null };
        NEEDS_REAUTH = true;
        await pollWorkspace('ws-1');
        expect(await getWorkspaceStatus('ws-1')).toMatchObject({
            connected: true,
            error: null,
            needsReauth: true,
        });
    });
});

describe('getWorkspaceRepoViews (per-repo error)', () => {
    it('carries the per-repo read error + precise detail onto the view', async () => {
        FETCH_RESULT = {
            items: [],
            error: 'forbidden',
            detail: { error: 'forbidden', status: 403, message: 'Resource not accessible' },
        };
        await pollWorkspace('ws-1');
        const views = await getWorkspaceRepoViews('ws-1');
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({
            owner: 'o',
            repo: 'r',
            enabled: true,
            error: 'forbidden',
            detail: { error: 'forbidden', status: 403, message: 'Resource not accessible' },
        });
    });
});

describe('worstViewError', () => {
    it('is null when every enabled repo read succeeded', () => {
        expect(
            worstViewError([
                { owner: 'o', repo: 'a', enabled: true, unread: 0, error: null, detail: null },
                { owner: 'o', repo: 'b', enabled: true, unread: 0, error: null, detail: null },
            ]),
        ).toBeNull();
    });

    it('returns the worst error across enabled repos and ignores disabled ones', () => {
        expect(
            worstViewError([
                { owner: 'o', repo: 'a', enabled: true, unread: 0, error: 'not_found', detail: null },
                { owner: 'o', repo: 'b', enabled: true, unread: 0, error: 'forbidden', detail: null },
                { owner: 'o', repo: 'c', enabled: false, unread: 0, error: 'unauthenticated', detail: null },
            ]),
        ).toBe('forbidden');
    });
});

describe('worstViewDetail', () => {
    it('is null when every enabled repo read succeeded', () => {
        expect(
            worstViewDetail([
                { owner: 'o', repo: 'a', enabled: true, unread: 0, error: null, detail: null },
            ]),
        ).toBeNull();
    });

    it('returns the detail of the WORST failure, matching the bucket worstViewError picks', () => {
        const views = [
            {
                owner: 'o',
                repo: 'a',
                enabled: true,
                unread: 0,
                error: 'not_found' as const,
                detail: { error: 'not_found' as const, status: 404, message: 'Not Found' },
            },
            {
                owner: 'o',
                repo: 'b',
                enabled: true,
                unread: 0,
                error: 'forbidden' as const,
                detail: { error: 'forbidden' as const, status: 403, message: 'No access' },
            },
        ];
        // forbidden is worse than not_found → its detail surfaces.
        expect(worstViewError(views)).toBe('forbidden');
        expect(worstViewDetail(views)).toEqual({
            error: 'forbidden',
            status: 403,
            message: 'No access',
        });
    });

    it('ignores disabled repos', () => {
        expect(
            worstViewDetail([
                {
                    owner: 'o',
                    repo: 'a',
                    enabled: false,
                    unread: 0,
                    error: 'unauthenticated' as const,
                    detail: { error: 'unauthenticated' as const, status: 401, message: 'Bad credentials' },
                },
            ]),
        ).toBeNull();
    });
});
