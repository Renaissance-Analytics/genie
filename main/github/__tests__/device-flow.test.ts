import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub App device flow: the device-code request carries NO `scope`
 * (permissions live on the App), and a token response with no `scope`
 * field is accepted (GitHub Apps don't return one).
 */

const fetchMock = vi.fn();

vi.mock('electron', () => ({
    net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));

import { refreshUserToken, requestDeviceCode } from '../device-flow';

function res(body: unknown) {
    return {
        status: 200,
        ok: true,
        statusText: 'OK',
        text: async () => JSON.stringify(body),
        json: async () => body,
    };
}

afterEach(() => fetchMock.mockReset());

describe('requestDeviceCode', () => {
    it('posts client_id WITHOUT a scope parameter', async () => {
        fetchMock.mockResolvedValueOnce(
            res({
                device_code: 'dc',
                user_code: 'UC-1234',
                verification_uri: 'https://github.com/login/device',
                expires_in: 900,
                interval: 5,
            }),
        );

        const code = await requestDeviceCode('Iv23liTestClientId');

        expect(code.user_code).toBe('UC-1234');
        const body = fetchMock.mock.calls[0][1].body as string;
        expect(body).toContain('client_id=Iv23liTestClientId');
        expect(body).not.toContain('scope');
    });
});

/**
 * Refreshing a user-to-server token (genie#263).
 *
 * The refresh_token grant and the device_code grant share ONE endpoint and are
 * not the same grant. GitHub waives the client secret for the device grant —
 * which is what the tests above cover, and what the docblock on
 * `refreshUserToken` used to cite as the reason it sent no secret. It does NOT
 * waive it for the refresh grant, and rejects a secret-less refresh with
 * `incorrect_client_credentials` — the exact value recorded in
 * `github_reauth_detail` on the install this issue was filed from, against a
 * refresh token with five months left to run.
 *
 * These assert the request BODY, deliberately. The mock answers 200 with an
 * access token whatever is posted, so "the call resolved" is green against the
 * broken version too — the body is the only place the defect is visible.
 */
describe('refreshUserToken', () => {
    it('posts the client secret — the refresh grant is not a device-flow grant', async () => {
        fetchMock.mockResolvedValueOnce(res({ access_token: 'ghu_new', token_type: 'bearer' }));

        await refreshUserToken('Iv23liTestClientId', 'ghr_old', 'sec_test');

        const body = fetchMock.mock.calls[0][1].body as string;
        expect(body).toContain('client_secret=sec_test');
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('client_id=Iv23liTestClientId');
        expect(body).toContain('refresh_token=ghr_old');
    });

    it('omits client_secret entirely when none is configured', async () => {
        // An EMPTY `client_secret=` is not the same as no field: it is a
        // credential GitHub can reject on its own terms. This must send neither.
        fetchMock.mockResolvedValueOnce(res({ access_token: 'ghu_new', token_type: 'bearer' }));

        await refreshUserToken('Iv23liTestClientId', 'ghr_old');

        const body = fetchMock.mock.calls[0][1].body as string;
        expect(body).not.toContain('client_secret');
        // POSITIVE CONTROL, in the same test: a `not.toContain` passes just as
        // happily against an empty body, or one this mock never received.
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=ghr_old');
    });
});
