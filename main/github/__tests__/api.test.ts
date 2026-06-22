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
    classifyFetchError,
    createRepo,
    fetchRepoWatchItemsResult,
    forkRepo,
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
                    { account: { login: 'me', id: 1, type: 'User', avatar_url: 'a' } },
                    { account: { login: 'acme-co', id: 2, type: 'Organization', avatar_url: 'b' } },
                ],
            }),
        );

        const installs = await listInstallations();
        expect(installs).toEqual([
            { login: 'me', avatar_url: 'a', id: 1, isOrg: false },
            { login: 'acme-co', avatar_url: 'b', id: 2, isOrg: true },
        ]);
    });

    it('returns [] when the App is installed nowhere', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { total_count: 0, installations: [] }));
        expect(await listInstallations()).toEqual([]);
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

    it('surfaces a forbidden ISSUES read (the read users care about)', async () => {
        fetchMock
            .mockResolvedValueOnce(res(403, { message: 'Resource not accessible by integration' }))
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(200, []));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBe('forbidden');
        expect(out.items).toEqual([]);
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
        fetchMock
            .mockResolvedValueOnce(res(200, []))
            .mockResolvedValueOnce(res(401, { message: 'Bad credentials' }))
            .mockResolvedValueOnce(res(200, []));

        const out = await fetchRepoWatchItemsResult('o', 'r');
        expect(out.error).toBe('unauthenticated');
    });
});
