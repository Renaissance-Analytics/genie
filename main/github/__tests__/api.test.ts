import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the GitHub-App-shaped API client: listOrgs reads
 * /user/installations (NOT /user/orgs, which is empty for App tokens), and
 * create/fork fold a "not installed on target account" failure into an
 * actionable install prompt.
 */

const fetchMock = vi.fn();

// Mutable storage state so individual tests can drive the token-refresh path
// (expired access token + a live refresh token) without re-mocking the module.
const store = {
    token: 'tok_test' as string | null,
    refreshToken: null as string | null,
    accessExpiryMs: null as number | null,
    refreshExpiryMs: null as number | null,
    reauthFlagged: false,
    saved: null as unknown,
};
const refreshUserTokenMock = vi.fn();

vi.mock('electron', () => ({
    net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));
vi.mock('../storage', () => ({
    getToken: () => store.token,
    getRefreshToken: () => store.refreshToken,
    getAccessExpiryMs: () => store.accessExpiryMs,
    getRefreshExpiryMs: () => store.refreshExpiryMs,
    getClientId: () => 'Iv_test',
    getUsername: () => 'me',
    markReauthNeeded: () => {
        store.reauthFlagged = true;
    },
    clearReauthNeeded: () => {
        store.reauthFlagged = false;
    },
    saveTokenSet: (set: unknown) => {
        store.saved = set;
    },
}));
vi.mock('../device-flow', () => ({
    refreshUserToken: (...args: unknown[]) => refreshUserTokenMock(...args),
}));

import {
    GitHubApiError,
    GitHubAuthError,
    GitHubNotInstalledError,
    classifyFetchDetail,
    classifyFetchError,
    createRepo,
    fetchRepoWatchItemsResult,
    fetchUpstreamWatchItems,
    forkRepo,
    getRepoMetadata,
    getRepoOwner,
    listInstallations,
    listOrgs,
    worseError,
} from '../api';

/** Build a Response-like object the gh() client understands. */
function res(status: number, body: unknown) {
    return {
        status,
        ok: status >= 200 && status < 300,
        statusText: `HTTP ${status}`,
        text: async () => (body == null ? '' : JSON.stringify(body)),
    };
}

afterEach(() => {
    fetchMock.mockReset();
    refreshUserTokenMock.mockReset();
    store.token = 'tok_test';
    store.refreshToken = null;
    store.accessExpiryMs = null;
    store.refreshExpiryMs = null;
    store.reauthFlagged = false;
    store.saved = null;
});

describe('listOrgs (GitHub App installations)', () => {
    it('maps Organization installations to org options and drops User installs', async () => {
        fetchMock.mockResolvedValueOnce(
            res(200, {
                total_count: 3,
                installations: [
                    { account: { login: 'acme-co', type: 'Organization', avatar_url: 'a' } },
                    { account: { login: 'me', type: 'User', avatar_url: 'b' } },
                    { account: { login: 'other-org', type: 'Organization', avatar_url: 'c' } },
                ],
            }),
        );

        const orgs = await listOrgs();

        // Only the Organization installs surface as orgs; the personal (User)
        // install is offered as the empty-string owner elsewhere.
        expect(orgs).toEqual([
            { login: 'acme-co', avatar_url: 'a' },
            { login: 'other-org', avatar_url: 'c' },
        ]);
        // It read installations, never the (empty-for-App-tokens) /user/orgs.
        const url = fetchMock.mock.calls[0][0] as string;
        expect(url).toContain('/user/installations');
        expect(url).not.toContain('/user/orgs');
    });

    it('tolerates a missing installations array', async () => {
        fetchMock.mockResolvedValueOnce(res(200, {}));
        expect(await listOrgs()).toEqual([]);
    });
});

describe('listInstallations (every installed account)', () => {
    it('returns personal AND org installs with id + isOrg', async () => {
        fetchMock.mockResolvedValueOnce(
            res(200, {
                installations: [
                    {
                        // Top-level installation id is distinct from account.id —
                        // it's what keys the per-install review URL.
                        id: 1001,
                        account: { login: 'me', id: 1, type: 'User', avatar_url: 'a' },
                        permissions: { metadata: 'read', issues: 'read' },
                    },
                    {
                        id: 2002,
                        account: { login: 'acme-co', id: 2, type: 'Organization', avatar_url: 'b' },
                    },
                ],
            }),
        );

        const installs = await listInstallations();
        expect(installs).toEqual([
            {
                login: 'me',
                avatar_url: 'a',
                id: 1,
                isOrg: false,
                installationId: 1001,
                permissions: { metadata: 'read', issues: 'read' },
            },
            // No permissions map in the response → defaults to {}.
            {
                login: 'acme-co',
                avatar_url: 'b',
                id: 2,
                isOrg: true,
                installationId: 2002,
                permissions: {},
            },
        ]);
    });

    it('returns [] when the App is installed nowhere', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { total_count: 0, installations: [] }));
        expect(await listInstallations()).toEqual([]);
    });
});

describe('reauth flag self-heal', () => {
    it('clears a stale reauth flag on a successful authenticated read', async () => {
        // The reported bug: a transient/preemptive refresh blip or a one-off 401
        // on some other endpoint flagged the session dead, but the token actually
        // works — a clean 2xx read must self-heal the flag so the "session
        // expired" banner clears while the issue counter shows live issues.
        store.reauthFlagged = true;
        fetchMock.mockResolvedValueOnce(res(200, { total_count: 0, installations: [] }));

        await listOrgs();

        expect(store.reauthFlagged).toBe(false);
    });

    it('leaves the flag set when the read is a genuine 401', async () => {
        // A real auth failure (no refresh token to retry) must NOT be cleared —
        // res.ok is false, so the self-heal never fires.
        store.reauthFlagged = true;
        fetchMock.mockResolvedValueOnce(res(401, { message: 'Bad credentials' }));

        await expect(listOrgs()).rejects.toThrow();
        expect(store.reauthFlagged).toBe(true);
    });
});

describe('getRepoOwner (source repo owner)', () => {
    it('resolves login + id + isOrg from the repo', async () => {
        fetchMock.mockResolvedValueOnce(
            res(200, { owner: { login: 'acme-co', id: 42, type: 'Organization' } }),
        );
        expect(await getRepoOwner('acme-co', 'thing')).toEqual({
            login: 'acme-co',
            id: 42,
            isOrg: true,
        });
    });

    it('falls back to the passed login when the lookup fails', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Not Found' }));
        expect(await getRepoOwner('hidden', 'repo')).toEqual({
            login: 'hidden',
            id: null,
            isOrg: false,
        });
    });
});

describe('getRepoMetadata (fork + upstream parsing)', () => {
    it('resolves the parent as upstream for a fork (parent preferred over source)', async () => {
        fetchMock.mockResolvedValueOnce(
            res(200, {
                owner: { login: 'me', id: 1, type: 'User' },
                fork: true,
                parent: { name: 'canonical', owner: { login: 'upstream-org' } },
                // A different `source` (root of the network) must be IGNORED when a
                // direct parent is present — we watch the repo we forked FROM.
                source: { name: 'root', owner: { login: 'root-org' } },
            }),
        );
        expect(await getRepoMetadata('me', 'canonical')).toEqual({
            owner: { login: 'me', id: 1, isOrg: false },
            fork: true,
            upstream: { owner: 'upstream-org', repo: 'canonical' },
        });
    });

    it('falls back to `source` when a fork has no direct `parent`', async () => {
        fetchMock.mockResolvedValueOnce(
            res(200, {
                owner: { login: 'me', id: 1, type: 'User' },
                fork: true,
                source: { name: 'root', owner: { login: 'root-org' } },
            }),
        );
        expect((await getRepoMetadata('me', 'root')).upstream).toEqual({
            owner: 'root-org',
            repo: 'root',
        });
    });

    it('returns upstream:null for a non-fork', async () => {
        fetchMock.mockResolvedValueOnce(
            res(200, { owner: { login: 'me', id: 1, type: 'User' }, fork: false }),
        );
        expect(await getRepoMetadata('me', 'original')).toEqual({
            owner: { login: 'me', id: 1, isOrg: false },
            fork: false,
            upstream: null,
        });
    });

    it('handles an orphan fork (fork:true but parent/source deleted) → upstream:null', async () => {
        fetchMock.mockResolvedValueOnce(
            res(200, { owner: { login: 'me', type: 'User' }, fork: true }),
        );
        const meta = await getRepoMetadata('me', 'orphan');
        expect(meta.fork).toBe(true);
        expect(meta.upstream).toBeNull();
    });

    it('THROWS on an HTTP failure (so the resolver can avoid caching a transient miss)', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Not Found' }));
        await expect(getRepoMetadata('hidden', 'repo')).rejects.toBeInstanceOf(GitHubApiError);
    });
});

describe('fetchUpstreamWatchItems (upstream issues + PRs only)', () => {
    it('tags items source:upstream and carries the upstream owner/repo', async () => {
        // Reads, in order: upstream issues, upstream pulls (NO security streams).
        fetchMock
            .mockResolvedValueOnce(
                res(200, [
                    {
                        number: 9,
                        title: 'upstream issue',
                        html_url: 'https://github.com/up/r/issues/9',
                        updated_at: '2026-06-20T10:00:00.000Z',
                        user: { login: 'maintainer' },
                    },
                ]),
            )
            .mockResolvedValueOnce(
                res(200, [
                    {
                        number: 4,
                        title: 'upstream PR',
                        html_url: 'https://github.com/up/r/pull/4',
                        updated_at: '2026-06-21T10:00:00.000Z',
                        user: { login: 'contrib' },
                    },
                ]),
            );

        const out = await fetchUpstreamWatchItems('up', 'r');
        expect(out.error).toBeNull();
        expect(out.items).toHaveLength(2);
        for (const it of out.items) {
            expect(it.source).toBe('upstream');
            expect(it.owner).toBe('up');
            expect(it.repo).toBe('r');
        }
        // Only two reads — security streams are never requested for upstream.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(out.items.find((i) => i.kind === 'issue')?.key).toBe('up/r:issue:9');
        expect(out.items.find((i) => i.kind === 'pr')?.key).toBe('up/r:pr:4');
    });

    it('skips the PRs read when includePulls is false (issues-only upstream)', async () => {
        fetchMock.mockResolvedValueOnce(res(200, []));
        const out = await fetchUpstreamWatchItems('up', 'r', false);
        expect(out.error).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1); // issues only
    });

    it('SILENTLY skips a forbidden upstream issues read (no access — normal for a fork)', async () => {
        fetchMock
            .mockResolvedValueOnce(res(403, { message: 'Resource not accessible by integration' }))
            .mockResolvedValueOnce(res(200, []));
        const out = await fetchUpstreamWatchItems('up', 'r');
        // A fork's install often can't read the parent's issues — that's NOT an
        // error worth surfacing, so it degrades to an empty success.
        expect(out.error).toBeNull();
        expect(out.detail).toBeNull();
        expect(out.items).toEqual([]);
    });

    it('SILENTLY skips a 404 upstream issues read too', async () => {
        fetchMock
            .mockResolvedValueOnce(res(404, { message: 'Not Found' }))
            .mockResolvedValueOnce(res(200, []));
        const out = await fetchUpstreamWatchItems('up', 'r');
        expect(out.error).toBeNull();
    });

    it('STILL surfaces an unauthenticated upstream read (token died — not fork-specific)', async () => {
        fetchMock
            .mockResolvedValueOnce(res(401, { message: 'Bad credentials' }))
            .mockResolvedValueOnce(res(200, []));
        const out = await fetchUpstreamWatchItems('up', 'r');
        expect(out.error).toBe('unauthenticated');
    });
});

describe('fetchRepoWatchItemsResult — kind gating (fetch side)', () => {
    it('skips the disabled streams entirely (security off ⇒ only issues + PRs requested)', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, [])) // issues
            .mockResolvedValueOnce(res(200, [])); // pulls
        const out = await fetchRepoWatchItemsResult('o', 'r', {
            issues: true,
            pulls: true,
            security: false,
        });
        expect(out.error).toBeNull();
        // Only issues + PRs hit the network — the three security endpoints are skipped.
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fetches nothing when every own kind is off', async () => {
        const out = await fetchRepoWatchItemsResult('o', 'r', {
            issues: false,
            pulls: false,
            security: false,
        });
        expect(out.items).toEqual([]);
        expect(out.error).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('not-installed install URL targeting', () => {
    it('createRepo pre-targets the chooser at the owner account id', async () => {
        fetchMock.mockResolvedValueOnce(res(403, { message: 'Resource not accessible by integration' }));
        try {
            await createRepo({ name: 'foo.agi', owner: 'acme-co', ownerId: 777 });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GitHubNotInstalledError);
            expect((e as GitHubNotInstalledError).installUrl).toMatch(
                /installations\/new\?suggested_target_id=777$/,
            );
        }
    });

    it('forkRepo passes the destination org id through to the install URL', async () => {
        fetchMock.mockResolvedValueOnce(res(403, { message: 'Resource not accessible by integration' }));
        try {
            await forkRepo({ owner: 'src', repo: 'thing', intoOrg: 'acme-co', intoOrgId: 99 });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GitHubNotInstalledError);
            expect((e as GitHubNotInstalledError).installUrl).toMatch(
                /suggested_target_id=99$/,
            );
        }
    });
});

describe('create/fork not-installed errors', () => {
    it('createRepo on an org turns a 403 into a GitHubNotInstalledError with the install URL', async () => {
        fetchMock.mockResolvedValueOnce(
            res(403, { message: 'Resource not accessible by integration' }),
        );

        await expect(
            createRepo({ name: 'foo.agi', owner: 'acme-co' }),
        ).rejects.toMatchObject({
            code: 'not_installed',
            account: 'acme-co',
        });

        // The message carries the install URL so the renderer can offer a
        // one-click install.
        try {
            fetchMock.mockResolvedValueOnce(
                res(403, { message: 'Resource not accessible by integration' }),
            );
            await createRepo({ name: 'foo.agi', owner: 'acme-co' });
        } catch (e) {
            expect(e).toBeInstanceOf(GitHubNotInstalledError);
            expect((e as GitHubNotInstalledError).installUrl).toMatch(
                /github\.com\/apps\/genie-ide\/installations\/new/,
            );
        }
    });

    it('forkRepo into an org folds a 404 into a not-installed prompt for that org', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Not Found' }));

        await expect(
            forkRepo({ owner: 'src', repo: 'thing', intoOrg: 'acme-co' }),
        ).rejects.toMatchObject({
            code: 'not_installed',
            account: 'acme-co',
        });
    });

    it('createRepo passes through a 422 name-exists by reusing the repo', async () => {
        // First POST: 422 already exists. Then getViewer, then GET repo.
        fetchMock
            .mockResolvedValueOnce(res(422, { message: 'name already exists on this account' }))
            .mockResolvedValueOnce(res(200, { login: 'me' }))
            .mockResolvedValueOnce(
                res(200, {
                    full_name: 'me/foo.agi',
                    clone_url: 'https://github.com/me/foo.agi.git',
                    ssh_url: 'git@github.com:me/foo.agi.git',
                    html_url: 'https://github.com/me/foo.agi',
                    default_branch: 'main',
                }),
            );

        const repo = await createRepo({ name: 'foo.agi' });
        expect(repo.full_name).toBe('me/foo.agi');
    });
});

describe('token refresh (expiring user-to-server tokens)', () => {
    it('refreshes proactively when the access token is past its recorded expiry', async () => {
        store.accessExpiryMs = Date.now() - 1000; // already expired
        store.refreshToken = 'ghr_old';
        refreshUserTokenMock.mockResolvedValueOnce({
            access_token: 'ghu_new',
            token_type: 'bearer',
            refresh_token: 'ghr_new',
            expires_in: 28800,
            refresh_token_expires_in: 15897600,
        });
        // After refresh, the actual API call succeeds.
        fetchMock.mockResolvedValueOnce(res(200, { installations: [] }));

        await listInstallations();

        expect(refreshUserTokenMock).toHaveBeenCalledWith('Iv_test', 'ghr_old');
        // The refreshed grant is persisted with the new access + refresh token.
        expect(store.saved).toMatchObject({ accessToken: 'ghu_new', refreshToken: 'ghr_new' });
        // The live request went out with the refreshed token.
        const authHeader = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> })
            .headers.Authorization;
        expect(authHeader).toBe('Bearer ghu_new');
    });

    it('refreshes reactively on a 401, then retries the request once', async () => {
        store.refreshToken = 'ghr_old';
        fetchMock
            .mockResolvedValueOnce(res(401, { message: 'Bad credentials' }))
            .mockResolvedValueOnce(res(200, { installations: [] }));
        refreshUserTokenMock.mockResolvedValueOnce({
            access_token: 'ghu_new',
            token_type: 'bearer',
            refresh_token: 'ghr_new',
            expires_in: 28800,
        });

        await listInstallations();

        expect(refreshUserTokenMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(store.reauthFlagged).toBe(false);
    });

    it('flags reauth when there is no refresh token and the call 401s', async () => {
        store.refreshToken = null;
        fetchMock.mockResolvedValueOnce(res(401, { message: 'Bad credentials' }));

        await expect(listInstallations()).rejects.toBeTruthy();
        expect(store.reauthFlagged).toBe(true);
        expect(refreshUserTokenMock).not.toHaveBeenCalled();
    });

    it('flags reauth when the refresh token itself is rejected', async () => {
        store.accessExpiryMs = Date.now() - 1000;
        store.refreshToken = 'ghr_dead';
        refreshUserTokenMock.mockRejectedValueOnce(new Error('refresh rejected'));

        await expect(listInstallations()).rejects.toBeInstanceOf(GitHubAuthError);
        expect(store.reauthFlagged).toBe(true);
    });
});

describe('classifyFetchError', () => {
    it('maps GitHubAuthError to unauthenticated', () => {
        expect(classifyFetchError(new GitHubAuthError())).toBe('unauthenticated');
    });
    it('maps a 403 permission denial to forbidden', () => {
        expect(classifyFetchError(new GitHubApiError(403, 'Resource not accessible'))).toBe(
            'forbidden',
        );
    });
    it('maps a 403 carrying a rate-limit message to rate_limited', () => {
        expect(
            classifyFetchError(new GitHubApiError(403, 'API rate limit exceeded')),
        ).toBe('rate_limited');
    });
    it('maps 429 to rate_limited and 404 to not_found', () => {
        expect(classifyFetchError(new GitHubApiError(429, 'Too Many Requests'))).toBe(
            'rate_limited',
        );
        expect(classifyFetchError(new GitHubApiError(404, 'Not Found'))).toBe('not_found');
    });
    it('maps anything else to unknown', () => {
        expect(classifyFetchError(new GitHubApiError(500, 'boom'))).toBe('unknown');
        expect(classifyFetchError(new Error('network'))).toBe('unknown');
    });
});

describe('classifyFetchDetail (precise status + message)', () => {
    it('captures the raw HTTP status + GitHub message off a GitHubApiError', () => {
        expect(classifyFetchDetail(new GitHubApiError(401, 'Bad credentials'))).toEqual({
            error: 'unauthenticated',
            status: 401,
            message: 'Bad credentials',
        });
        // The `unknown` bucket says nothing on its own — the precise detail is
        // what lets the flyout explain a 500.
        expect(classifyFetchDetail(new GitHubApiError(500, 'Internal Server Error'))).toEqual({
            error: 'unknown',
            status: 500,
            message: 'Internal Server Error',
        });
    });

    it('carries the auth-error message (no status) for a GitHubAuthError', () => {
        const d = classifyFetchDetail(new GitHubAuthError());
        expect(d.error).toBe('unauthenticated');
        expect(d.status).toBeUndefined();
        expect(d.message).toContain('No GitHub token');
    });

    it('keeps a generic Error message under the unknown bucket', () => {
        expect(classifyFetchDetail(new Error('network down'))).toEqual({
            error: 'unknown',
            message: 'network down',
        });
    });
});

describe('worseError (severity ordering)', () => {
    it('treats null (success) as never worse', () => {
        expect(worseError(null, null)).toBeNull();
        expect(worseError(null, 'forbidden')).toBe('forbidden');
        expect(worseError('forbidden', null)).toBe('forbidden');
    });
    it('ranks unauthenticated worst and unknown least', () => {
        expect(worseError('unauthenticated', 'forbidden')).toBe('unauthenticated');
        expect(worseError('unknown', 'not_found')).toBe('not_found');
        expect(worseError('rate_limited', 'unknown')).toBe('rate_limited');
    });
});

describe('fetchRepoWatchItemsResult (surfaced read outcome)', () => {
    it('returns items + null error when every read succeeds', async () => {
        fetchMock
            .mockResolvedValueOnce(
                res(200, [
                    {
                        number: 1,
                        title: 'an issue',
                        html_url: 'https://github.com/o/r/issues/1',
                        updated_at: '2026-06-16T10:00:00.000Z',
                        user: { login: 'me' },
                    },
                ]),
            )
            .mockResolvedValueOnce(res(200, [])) // pulls
            .mockResolvedValueOnce(res(200, [])); // dependabot

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBeNull();
        expect(out.items).toHaveLength(1);
        expect(out.items[0]).toMatchObject({ kind: 'issue', number: 1 });
    });

    it('surfaces a forbidden ISSUES read (the read users care about) WITH detail', async () => {
        fetchMock
            .mockResolvedValueOnce(res(403, { message: 'Resource not accessible by integration' }))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBe('forbidden');
        // The raw HTTP status + GitHub message ride along so the flyout can show
        // the exact cause, not just the bucket.
        expect(out.detail).toEqual({
            error: 'forbidden',
            status: 403,
            message: 'Resource not accessible by integration',
        });
        expect(out.items).toEqual([]);
    });

    it('returns a null detail when every read succeeds', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []));
        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBeNull();
        expect(out.detail).toBeNull();
    });

    it('does NOT let a Dependabot 403 mask a working issues read', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, [])) // issues OK (empty)
            .mockResolvedValueOnce(res(200, [])) // pulls OK
            .mockResolvedValueOnce(res(403, { message: 'Dependabot alerts are disabled' }));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        // The issues read succeeded → a genuine success, no surfaced error.
        expect(out.error).toBeNull();
        expect(out.items).toEqual([]);
    });

    it('escalates an unauthenticated secondary read (affects every read)', async () => {
        // Issues OK, but PRs come back unauthenticated (token died mid-poll) —
        // that's not feature-specific, so it escalates over a clean issues read.
        // Order of reads: issues, pulls, dependabot, code-scanning, secret-scanning.
        fetchMock
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(401, { message: 'Bad credentials' }))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBe('unauthenticated');
        // The escalated secondary failure brings its OWN detail along (it's now
        // the surfaced failure), so the precise 401 message reaches the flyout.
        expect(out.detail).toEqual({
            error: 'unauthenticated',
            status: 401,
            message: 'Bad credentials',
        });
    });
});

describe('fetchRepoWatchItemsResult — security alerts (Dependabot + Code + Secret scanning)', () => {
    it('maps Code-scanning and Secret-scanning alerts into normalized WatchItems', async () => {
        // Reads, in order: issues, pulls, dependabot, code-scanning, secret-scanning.
        fetchMock
            .mockResolvedValueOnce(res(200, [])) // issues
            .mockResolvedValueOnce(res(200, [])) // pulls
            .mockResolvedValueOnce(
                res(200, [
                    {
                        number: 7,
                        html_url: 'https://github.com/o/r/security/dependabot/7',
                        updated_at: '2026-06-16T10:00:00.000Z',
                        security_advisory: { summary: 'Prototype pollution', ghsa_id: 'GHSA-xxxx' },
                        security_vulnerability: { severity: 'high' },
                    },
                ]),
            )
            .mockResolvedValueOnce(
                res(200, [
                    {
                        number: 12,
                        html_url: 'https://github.com/o/r/security/code-scanning/12',
                        updated_at: '2026-06-17T10:00:00.000Z',
                        rule: { id: 'js/sql-injection', description: 'SQL injection', security_severity_level: 'critical' },
                    },
                ]),
            )
            .mockResolvedValueOnce(
                res(200, [
                    {
                        number: 3,
                        html_url: 'https://github.com/o/r/security/secret-scanning/3',
                        updated_at: '2026-06-18T10:00:00.000Z',
                        secret_type: 'aws_access_key',
                        secret_type_display_name: 'Amazon AWS Access Key',
                    },
                ]),
            );

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBeNull();

        const dep = out.items.find((i) => i.kind === 'dependabot');
        expect(dep).toMatchObject({
            kind: 'dependabot',
            title: 'Prototype pollution',
            severity: 'high',
            url: 'https://github.com/o/r/security/dependabot/7',
        });

        const code = out.items.find((i) => i.kind === 'code-scanning');
        expect(code).toMatchObject({
            kind: 'code-scanning',
            number: 12,
            title: 'SQL injection',
            severity: 'critical', // prefers security_severity_level
            url: 'https://github.com/o/r/security/code-scanning/12',
            key: 'o/r:code-scanning:12',
        });

        const secret = out.items.find((i) => i.kind === 'secret-scanning');
        expect(secret).toMatchObject({
            kind: 'secret-scanning',
            number: 3,
            title: 'Exposed secret: Amazon AWS Access Key',
            url: 'https://github.com/o/r/security/secret-scanning/3',
            key: 'o/r:secret-scanning:3',
        });
        // Secret-scanning alerts carry no severity (uniformly critical → unset).
        expect(secret?.severity).toBeUndefined();
    });

    it('keeps a Code-scanning 403 quiet — it must NOT mask a working issues read', async () => {
        // Issues + PRs OK, dependabot OK, but code-scanning is forbidden (the App
        // doesn't grant security_events yet). That's feature-specific, so it
        // stays quiet exactly like a Dependabot 403.
        fetchMock
            .mockResolvedValueOnce(res(200, [
                { number: 1, title: 'an issue', html_url: 'u', updated_at: '2026-06-16T10:00:00.000Z' },
            ]))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(403, { message: 'Code scanning is not enabled' }))
            .mockResolvedValueOnce(res(200, []));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        // The issues read succeeded → a genuine success, no surfaced error.
        expect(out.error).toBeNull();
        expect(out.detail).toBeNull();
        expect(out.items).toHaveLength(1);
        expect(out.items[0]).toMatchObject({ kind: 'issue', number: 1 });
    });

    it('keeps a Secret-scanning 403 quiet too (feature off / no access)', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(403, { message: 'Secret scanning is not available' }));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBeNull();
        expect(out.detail).toBeNull();
    });

    it('STILL escalates an unauthenticated security read (affects every read)', async () => {
        // A 401 from secret-scanning isn't feature-specific — the token died, so
        // it escalates over a clean issues read, bringing its own detail.
        fetchMock
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(401, { message: 'Bad credentials' }));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBe('unauthenticated');
        expect(out.detail).toMatchObject({ error: 'unauthenticated', status: 401 });
    });
});
