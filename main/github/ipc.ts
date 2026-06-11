import { ipcMain } from 'electron';
import {
    DeviceCodeResponse,
    DeviceFlowError,
    pollForToken,
    requestDeviceCode,
} from './device-flow';
import {
    clearToken,
    getBuiltInClientId,
    getClientId,
    getToken,
    getUsername,
    isStorageAvailable,
    saveToken,
} from './storage';
import {
    createRepo,
    getViewer,
    listOrgs,
    type CreateRepoOpts,
    type CreatedRepo,
    type GitHubOrg,
    type GitHubUser,
} from './api';

/**
 * IPC layer for GitHub. The Device Flow has two phases:
 *
 *   - `github:device:start` → returns the user_code + verification_uri
 *     so the renderer can show them. Also begins polling in the
 *     background.
 *   - `github:device:cancel` → aborts the poll.
 *   - `github:device:status` → reads the latest in-process status
 *     (pending, success, error).
 *
 * After a successful flow, the token is encrypted with safeStorage and
 * persisted via `storage.ts`. The renderer never sees the token —
 * only "connected as <username>" + the org list.
 */

type FlowStatus =
    | { kind: 'idle' }
    | { kind: 'pending'; userCode: string; verificationUri: string; expiresInSec: number }
    | { kind: 'success'; user: GitHubUser }
    | { kind: 'error'; code: string; message: string };

let status: FlowStatus = { kind: 'idle' };
let abortCtl: AbortController | null = null;

export function registerGithubIpc(): void {
    ipcMain.handle('github:status', async (): Promise<{
        connected: boolean;
        username: string | null;
        clientIdSet: boolean;
        builtInClientId: boolean;
        storageOk: boolean;
        flow: FlowStatus;
    }> => {
        return {
            connected: !!getToken(),
            username: getUsername(),
            clientIdSet: !!getClientId(),
            // True when the binary ships with a baked-in client ID
            // (config.GENIE_GITHUB_CLIENT_ID). Settings UI uses this
            // to hide the override field on normal installs.
            builtInClientId: !!getBuiltInClientId(),
            storageOk: isStorageAvailable(),
            flow: status,
        };
    });

    ipcMain.handle('github:device:start', async (): Promise<DeviceCodeResponse> => {
        if (abortCtl) abortCtl.abort();
        abortCtl = new AbortController();
        const clientId = getClientId();
        const code = await requestDeviceCode(clientId);
        status = {
            kind: 'pending',
            userCode: code.user_code,
            verificationUri: code.verification_uri,
            expiresInSec: code.expires_in,
        };
        // Kick off polling without awaiting — caller polls `github:status`
        // for progress.
        void pollForToken(
            clientId,
            code.device_code,
            code.interval,
            code.expires_in,
            abortCtl.signal,
        )
            .then(async (tok) => {
                try {
                    const user = await fetchUserWithToken(tok.access_token);
                    saveToken(tok.access_token, user.login);
                    status = { kind: 'success', user };
                } catch (e) {
                    status = {
                        kind: 'error',
                        code: 'whoami_failed',
                        message: (e as Error).message,
                    };
                }
            })
            .catch((e: unknown) => {
                if (e instanceof DeviceFlowError) {
                    status = { kind: 'error', code: e.code, message: e.message };
                } else {
                    status = {
                        kind: 'error',
                        code: 'unknown',
                        message: (e as Error).message,
                    };
                }
            });
        return code;
    });

    ipcMain.handle('github:device:cancel', async () => {
        abortCtl?.abort();
        abortCtl = null;
        status = { kind: 'idle' };
        return { ok: true };
    });

    ipcMain.handle('github:disconnect', async () => {
        abortCtl?.abort();
        abortCtl = null;
        clearToken();
        status = { kind: 'idle' };
        return { ok: true };
    });

    ipcMain.handle('github:user', async (): Promise<GitHubUser> => getViewer());
    ipcMain.handle('github:orgs', async (): Promise<GitHubOrg[]> => listOrgs());
    ipcMain.handle(
        'github:create-repo',
        async (_e, opts: CreateRepoOpts): Promise<CreatedRepo> => createRepo(opts),
    );
}

/**
 * Fetch the authenticated user without going through the storage layer.
 * Used inside the flow so we don't have to save-then-read.
 */
async function fetchUserWithToken(token: string): Promise<GitHubUser> {
    const { net } = await import('electron');
    const res = await net.fetch('https://api.github.com/user', {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Genie/0.7',
        },
    });
    if (!res.ok) {
        throw new Error(`GitHub /user → ${res.status}`);
    }
    return (await res.json()) as GitHubUser;
}
