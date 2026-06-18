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

import { requestDeviceCode } from '../device-flow';

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
