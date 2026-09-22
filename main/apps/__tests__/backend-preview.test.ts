import { expect, it, vi } from 'vitest';
vi.mock('../../db', () => ({ getAppGrant: () => null, getAppGrantForWorkspace: () => null }));
import { appGrantFor, appIdForBackendWorkspace } from '../grant-lookup';
import { rememberPreview, forgetPreview, type LivePreview } from '../preview-registry';
import { AppCredentials } from '../backend-credentials';
import { configureAppBackendEnv, appBackendEnv, clearAppBackendEnv } from '../backend-runtime';
it('uses the same consented preview grant and invalidates it when the preview closes', () => {
    const preview = { identity: { appId: 'preview-hb' }, workspaceId: 'preview-ws', grant: { appId: 'preview-hb', appName: 'Homeward Bound', workspaceId: 'preview-ws', scope: 'self', capabilities: ['notify'], revoked: false } } as LivePreview;
    const credentials = new AppCredentials(appGrantFor);
    rememberPreview(preview);
    configureAppBackendEnv(appIdForBackendWorkspace, credentials, 'http://127.0.0.1:12345/app');
    try {
        const env = appBackendEnv('preview-ws');
        expect(env.GENIE_APP_TOKEN).toBeDefined();
        expect(credentials.resolve(env.GENIE_APP_TOKEN).grant?.appId).toBe('preview-hb');
        forgetPreview('preview-hb');
        rememberPreview(preview);
        expect(credentials.resolve(env.GENIE_APP_TOKEN).grant).toBeUndefined();
    } finally { forgetPreview('preview-hb'); clearAppBackendEnv(); }
});
