import { expect, it } from 'vitest';
import { AppCredentials } from '../backend-credentials';
import { appBackendEnv, configureAppBackendEnv, revokeAppBackendCredentials } from '../backend-runtime';
it('injects only the owning grant credential and revokes credentials already held by backends', () => {
    const credentials = new AppCredentials(id => id === 'app' ? {
        appId: id, appName: 'App', workspaceId: 'own', scope: 'self', capabilities: ['notify'], revoked: false,
    } : null);
    configureAppBackendEnv(ws => ws === 'own' ? 'app' : null, credentials, 'http://127.0.0.1:12345/app');
    const env = appBackendEnv('own');
    expect(env.GENIE_APP_URL).toBe('http://127.0.0.1:12345/app');
    expect(credentials.resolve(env.GENIE_APP_TOKEN).grant?.workspaceId).toBe('own');
    expect(appBackendEnv('other')).toEqual({});
    expect(appBackendEnv(null)).toEqual({});
    revokeAppBackendCredentials('app');
    expect(credentials.resolve(env.GENIE_APP_TOKEN).grant).toBeUndefined();
});
it('refuses to inject when the grant has moved away from the process workspace', () => {
    const credentials = new AppCredentials(() => ({ appId: 'app', appName: 'App', workspaceId: 'moved', scope: 'self', capabilities: ['notify'], revoked: false }));
    configureAppBackendEnv(() => 'app', credentials, 'http://127.0.0.1:12345/app');
    expect(() => appBackendEnv('old-workspace')).toThrow(/workspace/);
});
