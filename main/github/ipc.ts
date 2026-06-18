import { ipcMain } from 'electron';
import { genieInstallUrl } from '../config';
import {
    DeviceCodeResponse,
    DeviceFlowError,
    pollForToken,
    requestDeviceCode,
} from './device-flow';
import {
    clearClientIdOverride,
    clearToken,
    getBuiltInClientId,
    getClientId,
    getClientIdOverride,
    getToken,
    getUsername,
    isStorageAvailable,
    saveToken,
} from './storage';
import {
    createRepo,
    forkRepo,
    getRepoOwner,
    getViewer,
    listInstallations,
    listOrgs,
    parseGitHubRemote,
    type CreateRepoOpts,
    type CreatedRepo,
    type ForkRepoOpts,
    type GitHubInstallation,
    type GitHubOrg,
    type GitHubUser,
    type ParsedRepoRef,
    type RepoOwner,
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
        usingOverride: boolean;
        activeClientId: string;
        storageOk: boolean;
        flow: FlowStatus;
    }> => {
        const override = getClientIdOverride();
        const active = getClientId();
        return {
            connected: !!getToken(),
            username: getUsername(),
            clientIdSet: !!active,
            // True when the binary ships with a baked-in client ID
            // (config.GENIE_GITHUB_CLIENT_ID). Settings UI uses this
            // to hide the override field on normal installs.
            builtInClientId: !!getBuiltInClientId(),
            // True when a settings override is shadowing the bundled ID —
            // the prime suspect when Device Flow fails on a build that
            // ships a working baked-in client ID.
            usingOverride: !!override,
            // Masked for display so the user can sanity-check which ID is
            // actually in play without leaking it to logs/screenshots.
            activeClientId: maskClientId(active),
            storageOk: isStorageAvailable(),
            flow: status,
        };
    });

    ipcMain.handle('github:reset-client-id', async () => {
        clearClientIdOverride();
        return { ok: true };
    });

    // Where to send the user to install the "Genie IDE" GitHub App. With no
    // arg this is the account chooser (personal + every installable org); pass
    // a numeric account id to pre-target the chooser at that account (e.g. the
    // owner of a repo being forked).
    ipcMain.handle(
        'github:install-url',
        async (_e, targetId?: number | null): Promise<string> =>
            genieInstallUrl(targetId),
    );

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
    // Every account the App is installed on (personal + orgs) — the connect
    // flow uses this to detect zero/missing installs and drive the chooser.
    ipcMain.handle(
        'github:installations',
        async (): Promise<GitHubInstallation[]> => listInstallations(),
    );
    // Resolve a source repo's owner so create/fork can target the SAME
    // account (personal or org) the original repo lives in.
    ipcMain.handle(
        'github:repo-owner',
        async (_e, owner: string, repo: string): Promise<RepoOwner> =>
            getRepoOwner(owner, repo),
    );
    ipcMain.handle(
        'github:create-repo',
        async (_e, opts: CreateRepoOpts): Promise<CreatedRepo> => createRepo(opts),
    );
    ipcMain.handle(
        'github:fork-repo',
        async (_e, opts: ForkRepoOpts): Promise<CreatedRepo> => forkRepo(opts),
    );
    // Pure helper — lets the renderer decide whether to OFFER a fork for a
    // given submodule source URL without duplicating the parser.
    ipcMain.handle(
        'github:parse-remote',
        async (_e, url: string): Promise<ParsedRepoRef | null> =>
            parseGitHubRemote(url),
    );
}

/** Show the first 7 + last 3 chars so the user can recognise their ID
 *  without exposing the whole value. Short IDs are shown whole. */
function maskClientId(id: string): string {
    if (!id) return '';
    if (id.length <= 12) return id;
    return `${id.slice(0, 7)}…${id.slice(-3)}`;
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
