/**
 * GitHub Device Flow OAuth — the right shape for desktop apps. No
 * embedded browser, no client secret embedded in the binary, no
 * loopback redirect listener.
 *
 *   1. POST https://github.com/login/device/code     — get device_code + user_code
 *   2. Show the user_code + verification_uri to the user.
 *   3. POST https://github.com/login/oauth/access_token (every `interval` seconds)
 *      until the user finishes (success), denies, or the code expires.
 *
 * The client_id is a public identifier baked into your OAuth App on
 * GitHub. It is not a secret — but it IS a config value, so we read it
 * from settings instead of hardcoding it. You register an OAuth App at
 * https://github.com/settings/applications/new (or under an org), tick
 * "Enable Device Flow", and paste the client ID into Genie's Settings.
 *
 * Scopes (Genie is a full workspace + bridge between Tynn, local dev,
 * and Aionima — it needs broad repo access, not just create):
 *   - `repo`     — full control of repositories (read code, write
 *                  commits + branches, manage PRs/issues, create new
 *                  repos under the user's account). One scope, lumped
 *                  by GitHub.
 *   - `workflow` — write `.github/workflows/*.yml`. Needed when Genie
 *                  scaffolds CI for `.agi` envelopes. Granted at
 *                  connect time so the user doesn't re-auth later.
 *   - `read:org` — list orgs the user belongs to so the wizard can
 *                  offer "create in <org>" alongside "create in <user>".
 *
 * Notably absent: `delete_repo`. Genie should not be capable of
 * deleting repositories; add this scope only when there's a concrete
 * workflow that needs it.
 */

import { net } from 'electron';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const SCOPE = 'repo workflow read:org';

export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

export interface TokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
}

export class DeviceFlowError extends Error {
    constructor(public code: string, message: string) {
        super(message);
        this.name = 'DeviceFlowError';
    }
}

async function postForm(
    url: string,
    body: Record<string, string>,
): Promise<Record<string, string>> {
    const params = new URLSearchParams(body);
    const res = await net.fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new DeviceFlowError(
            `http_${res.status}`,
            `GitHub returned ${res.status}: ${text || res.statusText}`,
        );
    }
    return (await res.json()) as Record<string, string>;
}

/**
 * Step 1 — ask GitHub for a device + user code.
 * Step 2 (display the user_code) happens in the renderer.
 */
export async function requestDeviceCode(
    clientId: string,
): Promise<DeviceCodeResponse> {
    if (!clientId) {
        throw new DeviceFlowError(
            'missing_client_id',
            'No GitHub client ID configured. Register an OAuth App with Device Flow enabled and paste its client ID into Settings.',
        );
    }
    const json = await postForm(DEVICE_CODE_URL, {
        client_id: clientId,
        scope: SCOPE,
    });
    return {
        device_code: json.device_code,
        user_code: json.user_code,
        verification_uri: json.verification_uri,
        expires_in: Number(json.expires_in ?? 0),
        interval: Number(json.interval ?? 5),
    };
}

/**
 * Step 3 — poll for the access token. Resolves once GitHub returns one,
 * rejects with a typed error if the user denied or the code expired.
 * Caller supplies a cancellation signal so a UI close can abort.
 */
export async function pollForToken(
    clientId: string,
    deviceCode: string,
    initialIntervalSec: number,
    expiresInSec: number,
    signal?: AbortSignal,
): Promise<TokenResponse> {
    let interval = Math.max(1, initialIntervalSec);
    const deadline = Date.now() + expiresInSec * 1000;

    while (true) {
        if (signal?.aborted) {
            throw new DeviceFlowError('cancelled', 'Sign-in cancelled.');
        }
        if (Date.now() > deadline) {
            throw new DeviceFlowError(
                'expired',
                'The device code expired before the flow completed. Start sign-in again.',
            );
        }
        await sleep(interval * 1000, signal);

        let res: Record<string, string>;
        try {
            res = await postForm(TOKEN_URL, {
                client_id: clientId,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            });
        } catch (e) {
            if (e instanceof DeviceFlowError) throw e;
            throw new DeviceFlowError(
                'network',
                `Network error polling GitHub: ${(e as Error).message}`,
            );
        }

        if (res.access_token) {
            return {
                access_token: res.access_token,
                token_type: res.token_type ?? 'bearer',
                scope: res.scope ?? SCOPE,
            };
        }

        // Documented error codes — most are "keep polling" signals.
        switch (res.error) {
            case 'authorization_pending':
                // Keep polling at the current interval.
                continue;
            case 'slow_down':
                // GitHub asks us to back off. Bump the interval +5s per spec.
                interval += 5;
                continue;
            case 'expired_token':
                throw new DeviceFlowError(
                    'expired',
                    'The device code expired. Start sign-in again.',
                );
            case 'access_denied':
                throw new DeviceFlowError(
                    'denied',
                    'You denied access. To finish setup, retry and approve the request.',
                );
            default:
                throw new DeviceFlowError(
                    res.error ?? 'unknown',
                    res.error_description ?? 'Unknown GitHub Device Flow error.',
                );
        }
    }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(new DeviceFlowError('cancelled', 'Sign-in cancelled.'));
        };
        const cleanup = () => {
            clearTimeout(t);
            signal?.removeEventListener('abort', onAbort);
        };
        if (signal?.aborted) {
            cleanup();
            reject(new DeviceFlowError('cancelled', 'Sign-in cancelled.'));
            return;
        }
        signal?.addEventListener('abort', onAbort);
    });
}
