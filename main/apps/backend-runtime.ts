import type { AppCredentials } from './backend-credentials';
let current: { lookup: (workspaceId: string) => string | null; credentials: AppCredentials; url: string } | null = null;
export function configureAppBackendEnv(lookup: (workspaceId: string) => string | null, credentials: AppCredentials, url: string): void {
    current = { lookup, credentials, url };
}
export function clearAppBackendEnv(): void { current = null; }
export function appBackendEnv(workspaceId: string | null | undefined): Record<string, string> {
    if (!current || !workspaceId) return {};
    const appId = current.lookup(workspaceId);
    if (!appId) return {};
    const token = current.credentials.mint(appId);
    if (current.credentials.resolve(token).grant?.workspaceId !== workspaceId) {
        throw new Error('App credential does not belong to this process workspace.');
    }
    return { GENIE_APP_URL: current.url, GENIE_APP_TOKEN: token };
}
export function revokeAppBackendCredentials(appId: string): void { current?.credentials.revoke(appId); }
