import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The per-workspace IssueWatch GRANULARITY gate (Part B) + the fork→upstream
 * RESOLVER cache/staleness (Part A). We mock the db + git + github layers so a
 * workspace resolves to one repo, drive the granularity + fork cache + the
 * (mocked) own/upstream fetches, poll, and assert:
 *   - `filterByGranularity` keeps exactly the kinds a workspace wants;
 *   - `getOpenCounts` honours that gate (security off ⇒ no security dot; upstream
 *     none/issues/issues+prs include the right upstream items);
 *   - `resolveUpstream` trusts a fresh cache, re-resolves a stale/missing one, and
 *     never poisons the cache on a failed lookup.
 */

const WS = { id: 'ws-1', path: '/ws/demo.agi' };

const item = (kind: string, number: number, source?: 'own' | 'upstream') => ({
    kind,
    key: `k:${kind}:${number}:${source ?? 'own'}`,
    number,
    title: `${kind}-${number}`,
    url: 'u',
    updatedAt: '2026-06-20T10:00:00.000Z',
    ...(source === 'upstream' ? { source, owner: 'up', repo: 'r' } : {}),
});

// Mutable test drivers.
let OWN_ITEMS: ReturnType<typeof item>[] = [];
let UPSTREAM_ITEMS: ReturnType<typeof item>[] = [];
let GRANULARITY: {
    own: { issues: boolean; pulls: boolean; security: boolean };
    upstream: 'none' | 'issues' | 'issues+prs';
} = { own: { issues: true, pulls: true, security: true }, upstream: 'none' };

// fork_upstream cache, keyed `${owner}/${repo}`.
let FORK_CACHE: Record<
    string,
    {
        owner: string;
        repo: string;
        is_fork: number;
        upstream_owner: string | null;
        upstream_repo: string | null;
        checked_at: string;
    }
> = {};
const setForkUpstreamMock = vi.fn(
    (
        owner: string,
        repo: string,
        isFork: boolean,
        upOwner: string | null,
        upRepo: string | null,
        checkedAt?: string,
    ) => {
        FORK_CACHE[`${owner}/${repo}`] = {
            owner,
            repo,
            is_fork: isFork ? 1 : 0,
            upstream_owner: upOwner,
            upstream_repo: upRepo,
            checked_at: checkedAt ?? new Date().toISOString(),
        };
    },
);
const getRepoMetadataMock = vi.fn();

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
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../db', () => ({
    getWorkspace: () => WS,
    listIssueWatches: () => [],
    listWorkspaces: () => [WS],
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
    getWorkspaceIssuewatchGranularity: () => GRANULARITY,
    getForkUpstream: (owner: string, repo: string) => FORK_CACHE[`${owner}/${repo}`],
    setForkUpstream: (...args: unknown[]) =>
        (setForkUpstreamMock as (...a: unknown[]) => void)(...args),
}));
vi.mock('../../github/api', () => ({
    // Honour the FETCH-side gate so the test exercises both fetch + read gating.
    fetchRepoWatchItemsResult: async (
        _o: string,
        _r: string,
        kinds: { issues: boolean; pulls: boolean; security: boolean },
    ) => {
        const items = OWN_ITEMS.filter((it) => {
            if (it.kind === 'issue') return kinds.issues;
            if (it.kind === 'pr') return kinds.pulls;
            return kinds.security;
        });
        return { items, error: null, detail: null };
    },
    fetchUpstreamWatchItems: async (_o: string, _r: string, includePulls: boolean) => {
        const items = UPSTREAM_ITEMS.filter(
            (it) => it.kind === 'issue' || (it.kind === 'pr' && includePulls),
        );
        return { items, error: null, detail: null };
    },
    getRepoMetadata: (...args: unknown[]) =>
        (getRepoMetadataMock as (...a: unknown[]) => unknown)(...args),
    parseGitHubRemote: () => ({ owner: 'o', repo: 'r' }),
    worseError: (a: string | null, b: string | null) => a ?? b,
    isSecurityKind: (kind: string) =>
        kind === 'dependabot' || kind === 'code-scanning' || kind === 'secret-scanning',
}));
vi.mock('../../github/storage', () => ({ getToken: () => 'tok' }));

import {
    filterByGranularity,
    resolveUpstream,
    getOpenCounts,
    pollWorkspace,
} from '../index';
import type { WatchItem } from '../../github/api';

const ISO_NOW = () => new Date().toISOString();
const ISO_DAYS_AGO = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
    OWN_ITEMS = [];
    UPSTREAM_ITEMS = [];
    GRANULARITY = { own: { issues: true, pulls: true, security: true }, upstream: 'none' };
    FORK_CACHE = {};
    setForkUpstreamMock.mockClear();
    getRepoMetadataMock.mockReset();
});

describe('filterByGranularity', () => {
    const own = (kind: string) => item(kind, 1) as unknown as WatchItem;
    const up = (kind: string) => item(kind, 1, 'upstream') as unknown as WatchItem;

    it('drops own kinds that are toggled off', () => {
        const items = [own('issue'), own('pr'), own('dependabot')];
        const out = filterByGranularity(items, {
            own: { issues: true, pulls: false, security: false },
            upstream: 'none',
        });
        expect(out.map((i) => i.kind)).toEqual(['issue']);
    });

    it('upstream:none drops every upstream item', () => {
        const items = [own('issue'), up('issue'), up('pr')];
        const out = filterByGranularity(items, {
            own: { issues: true, pulls: true, security: true },
            upstream: 'none',
        });
        expect(out.every((i) => (i.source ?? 'own') === 'own')).toBe(true);
    });

    it('upstream:issues keeps upstream issues but drops upstream PRs', () => {
        const items = [up('issue'), up('pr')];
        const out = filterByGranularity(items, {
            own: { issues: true, pulls: true, security: true },
            upstream: 'issues',
        });
        expect(out.map((i) => i.kind)).toEqual(['issue']);
    });

    it('upstream:issues+prs keeps both upstream issues and PRs', () => {
        const items = [up('issue'), up('pr')];
        const out = filterByGranularity(items, {
            own: { issues: true, pulls: true, security: true },
            upstream: 'issues+prs',
        });
        expect(out.map((i) => i.kind).sort()).toEqual(['issue', 'pr']);
    });
});

describe('getOpenCounts — granularity gates the pill', () => {
    it('drops the security dot when security is toggled off', async () => {
        OWN_ITEMS = [item('issue', 1), item('pr', 2), item('dependabot', 3)];
        GRANULARITY = { own: { issues: true, pulls: true, security: true }, upstream: 'none' };
        await pollWorkspace('ws-1');
        expect((await getOpenCounts())['ws-1']).toEqual({ issue: 1, pr: 1, security: 1 });

        GRANULARITY = { own: { issues: true, pulls: true, security: false }, upstream: 'none' };
        await pollWorkspace('ws-1');
        expect((await getOpenCounts())['ws-1']).toEqual({ issue: 1, pr: 1, security: 0 });
    });

    it('includes upstream Issues/PRs in the pill per the upstream setting', async () => {
        OWN_ITEMS = [item('issue', 1)];
        UPSTREAM_ITEMS = [item('issue', 9, 'upstream'), item('pr', 4, 'upstream')];
        // A fresh fork-cache entry so the resolver returns the upstream with no
        // network (getRepoMetadata) call.
        FORK_CACHE['o/r'] = {
            owner: 'o',
            repo: 'r',
            is_fork: 1,
            upstream_owner: 'up',
            upstream_repo: 'r',
            checked_at: ISO_NOW(),
        };

        GRANULARITY = { own: { issues: true, pulls: true, security: true }, upstream: 'none' };
        await pollWorkspace('ws-1');
        expect((await getOpenCounts())['ws-1']).toEqual({ issue: 1, pr: 0, security: 0 });

        GRANULARITY = { own: { issues: true, pulls: true, security: true }, upstream: 'issues' };
        await pollWorkspace('ws-1');
        expect((await getOpenCounts())['ws-1']).toEqual({ issue: 2, pr: 0, security: 0 });

        GRANULARITY = { own: { issues: true, pulls: true, security: true }, upstream: 'issues+prs' };
        await pollWorkspace('ws-1');
        expect((await getOpenCounts())['ws-1']).toEqual({ issue: 2, pr: 1, security: 0 });
    });
});

describe('resolveUpstream — fork→upstream cache + staleness', () => {
    it('trusts a FRESH cache entry without re-resolving', async () => {
        FORK_CACHE['o/r'] = {
            owner: 'o',
            repo: 'r',
            is_fork: 1,
            upstream_owner: 'up',
            upstream_repo: 'canonical',
            checked_at: ISO_NOW(),
        };
        const ref = await resolveUpstream('o', 'r');
        expect(ref).toEqual({ owner: 'up', repo: 'canonical' });
        expect(getRepoMetadataMock).not.toHaveBeenCalled();
    });

    it('returns null (no network) for a fresh NON-fork cache entry', async () => {
        FORK_CACHE['o/r'] = {
            owner: 'o',
            repo: 'r',
            is_fork: 0,
            upstream_owner: null,
            upstream_repo: null,
            checked_at: ISO_NOW(),
        };
        expect(await resolveUpstream('o', 'r')).toBeNull();
        expect(getRepoMetadataMock).not.toHaveBeenCalled();
    });

    it('re-resolves a STALE entry and writes the fresh result back', async () => {
        FORK_CACHE['o/r'] = {
            owner: 'o',
            repo: 'r',
            is_fork: 1,
            upstream_owner: 'old',
            upstream_repo: 'old',
            checked_at: ISO_DAYS_AGO(8), // older than the ~7-day window
        };
        getRepoMetadataMock.mockResolvedValueOnce({
            owner: { login: 'o', id: null, isOrg: false },
            fork: true,
            upstream: { owner: 'up', repo: 'fresh' },
        });
        const ref = await resolveUpstream('o', 'r');
        expect(getRepoMetadataMock).toHaveBeenCalledTimes(1);
        expect(setForkUpstreamMock).toHaveBeenCalledWith('o', 'r', true, 'up', 'fresh');
        expect(ref).toEqual({ owner: 'up', repo: 'fresh' });
    });

    it('resolves + caches a MISSING entry (first sighting of the repo)', async () => {
        getRepoMetadataMock.mockResolvedValueOnce({
            owner: { login: 'o', id: null, isOrg: false },
            fork: true,
            upstream: { owner: 'up', repo: 'new' },
        });
        const ref = await resolveUpstream('o', 'r');
        expect(getRepoMetadataMock).toHaveBeenCalledTimes(1);
        expect(setForkUpstreamMock).toHaveBeenCalledWith('o', 'r', true, 'up', 'new');
        expect(ref).toEqual({ owner: 'up', repo: 'new' });
    });

    it('caches a non-fork as is_fork=false so a re-poll skips the network', async () => {
        getRepoMetadataMock.mockResolvedValueOnce({
            owner: { login: 'o', id: null, isOrg: false },
            fork: false,
            upstream: null,
        });
        expect(await resolveUpstream('o', 'r')).toBeNull();
        expect(setForkUpstreamMock).toHaveBeenCalledWith('o', 'r', false, null, null);
    });

    it('does NOT poison the cache when the lookup fails — falls back to the stale entry', async () => {
        FORK_CACHE['o/r'] = {
            owner: 'o',
            repo: 'r',
            is_fork: 1,
            upstream_owner: 'up',
            upstream_repo: 'stale',
            checked_at: ISO_DAYS_AGO(30),
        };
        getRepoMetadataMock.mockRejectedValueOnce(new Error('transient 500'));
        const ref = await resolveUpstream('o', 'r');
        // Falls back to the stale cache, and crucially never WRITES a wrong answer.
        expect(ref).toEqual({ owner: 'up', repo: 'stale' });
        expect(setForkUpstreamMock).not.toHaveBeenCalled();
    });
});
