import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Story #197 — the server-fed override. When Tynn pushes an `issuewatch.delta`
 * for a workspace, `applyPushedDelta` switches that workspace to SERVER-FED: the
 * read paths return Tynn's snapshot, the poller skips it, and it reports
 * connected even with NO local GitHub token (the hard-cut to server-push).
 */

const WS = { id: 'ws-1', path: '/ws/demo.agi' };
let TOKEN: string | null = 'tok';

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
}));
vi.mock('simple-git', () => ({ default: () => ({ getRemotes: async () => [] }) }));
vi.mock('../../db', () => ({
    getWorkspace: () => WS,
    listIssueWatches: () => [],
    listWorkspaces: () => [WS],
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
    getWorkspaceIssuewatchGranularity: () => ({ own: { issues: true, pulls: true, security: true }, upstream: 'none' }),
    getForkUpstream: () => undefined,
    setForkUpstream: () => {},
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../github/api', () => ({
    fetchRepoWatchItemsResult: async () => ({ items: [], error: null, detail: null }),
    fetchUpstreamWatchItems: async () => ({ items: [], error: null, detail: null }),
    getRepoMetadata: async () => ({ owner: { login: 'o' }, fork: false, upstream: null }),
    isSecurityKind: (k: string) => k === 'dependabot' || k === 'code-scanning' || k === 'secret-scanning',
    parseGitHubRemote: () => ({ owner: 'o', repo: 'r' }),
    worseError: (a: string | null, b: string | null) => a ?? b,
}));
vi.mock('../../github/storage', () => ({ getToken: () => TOKEN, needsReauth: () => false }));
vi.mock('../../github/capability-service', () => ({
    getCapabilities: () => ({ connected: true, satisfiedFeatures: [], missing: [], missingPermissions: [], missingByPermission: [], appPermissionsUrl: '', checked: true }),
}));
// Isolate the broadcast — the override just needs to not throw here.
vi.mock('../../remote', () => ({ broadcastLocal: () => {} }));
vi.mock('../../mobile/bus', () => ({ mobileEmit: () => {} }));

import {
    applyPushedDelta,
    clearPushedDelta,
    getOpenCounts,
    getWorkspaceFeed,
    getWorkspaceStatus,
    isServerFed,
    setIssueWatchServiceState,
} from '../index';

const delta = (over: Partial<Parameters<typeof applyPushedDelta>[0]> = {}) => ({
    workspaceId: 'ws-1',
    counts: { issue: 1, pr: 0, security: 2 },
    items: [
        { kind: 'issue' as const, key: 'o/r:issue:1', number: 1, title: 'Bug', url: 'u', updatedAt: '2026-07-09T00:00:00Z', owner: 'o', repo: 'r', source: 'own' as const, unread: true },
    ],
    ...over,
});

beforeEach(() => {
    TOKEN = 'tok';
    clearPushedDelta('ws-1');
});

describe('server-fed IssueWatch override (#197)', () => {
    beforeEach(() => setIssueWatchServiceState('connecting'));
    it('applyPushedDelta makes a workspace server-fed and serves Tynn counts + feed', async () => {
        applyPushedDelta(delta());

        expect(isServerFed('ws-1')).toBe(true);
        expect(await getOpenCounts()).toEqual({ 'ws-1': { issue: 1, pr: 0, security: 2 } });
        const feed = await getWorkspaceFeed('ws-1');
        expect(feed).toHaveLength(1);
        expect(feed[0]).toMatchObject({ key: 'o/r:issue:1', kind: 'issue', unread: true, owner: 'o', repo: 'r' });
    });

    it('a server-fed workspace is connected + error-free even with NO local token (the hard-cut)', async () => {
        TOKEN = null; // client has no GitHub credential at all
        applyPushedDelta(delta());

        expect(await getWorkspaceStatus('ws-1')).toEqual({
            connected: true, error: null, detail: null, needsReauth: false, missingCapabilities: [],
        });
        expect(await getOpenCounts()).toEqual({ 'ws-1': { issue: 1, pr: 0, security: 2 } });
    });

    it('clearing a snapshot never re-enables local GitHub IssueWatch', async () => {
        applyPushedDelta(delta());
        expect(isServerFed('ws-1')).toBe(true);

        clearPushedDelta('ws-1');
        expect(isServerFed('ws-1')).toBe(false);
        setIssueWatchServiceState('disconnected');
        expect((await getWorkspaceStatus('ws-1')).connected).toBe(false);
        expect(await getWorkspaceFeed('ws-1')).toEqual([]);
    });

    it('reports explicit Tynn stream health without consulting the local GitHub token', async () => {
        TOKEN = 'local-token-that-must-not-matter';
        setIssueWatchServiceState('disabled');
        expect(await getWorkspaceStatus('ws-1')).toMatchObject({
            connected: false,
            needsReauth: false,
            serviceState: 'disabled',
        });
    });

    it('zero-count server-fed workspace is omitted from the counts map (no dark pill regressions)', async () => {
        applyPushedDelta(delta({ counts: { issue: 0, pr: 0, security: 0 } }));
        expect(await getOpenCounts()).toEqual({});
    });
});
