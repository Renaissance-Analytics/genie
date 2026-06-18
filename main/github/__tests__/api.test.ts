import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the GitHub-App-shaped API client: listOrgs reads
 * /user/installations (NOT /user/orgs, which is empty for App tokens), and
 * create/fork fold a "not installed on target account" failure into an
 * actionable install prompt.
 */

const fetchMock = vi.fn();

vi.mock('electron', () => ({
    net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));
vi.mock('../storage', () => ({ getToken: () => 'tok_test' }));

import {
    GitHubNotInstalledError,
    createRepo,
    forkRepo,
    listOrgs,
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
