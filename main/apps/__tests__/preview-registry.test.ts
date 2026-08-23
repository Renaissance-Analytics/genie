import { beforeEach, describe, expect, it } from 'vitest';
import {
    forgetPreview,
    listPreviews,
    livePreview,
    previewForWorkspace,
    rememberPreview,
    resolveAppGrant,
    type LivePreview,
} from '../preview-registry';
import { previewGrant, previewIdentityFor, previewManifest } from '../preview';
import { validateAppManifest, type AppManifest } from '../manifest';
import type { AppGrant } from '../bridge-decision';

function manifest(over: Record<string, unknown> = {}): AppManifest {
    const parsed = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: ['hosting'] },
        ...over,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.value;
}

function preview(source: AppManifest, workspaceId = 'preview-ws-1'): LivePreview {
    const identity = previewIdentityFor(source);
    return {
        identity,
        source,
        manifest: previewManifest(source),
        folder: 'C:/dev/trader',
        workspaceId,
        grant: previewGrant(source, identity, workspaceId, {
            scope: 'self',
            capabilities: ['hosting'],
        }),
        siteId: 'site-preview-1',
        warnings: [],
    };
}

beforeEach(() => {
    for (const live of listPreviews()) forgetPreview(live.identity.appId);
});

describe('the live preview registry', () => {
    it('finds a preview by its app id and by its workspace', () => {
        const live = preview(manifest());
        rememberPreview(live);

        expect(livePreview('com.example.trader~preview')).toBe(live);
        expect(previewForWorkspace('preview-ws-1')).toBe(live);
    });

    it('never answers for the app the preview is OF', () => {
        // The whole promise of previewing is that it installs nothing. An id
        // lookup that fell back to the real app would make a preview able to act
        // as the installed copy — the same confusion the bridge's separate
        // shell/view maps exist to prevent, one layer up.
        rememberPreview(preview(manifest()));

        expect(livePreview('com.example.trader')).toBeNull();
    });

    it('forgets everything a preview was findable by', () => {
        rememberPreview(preview(manifest()));
        forgetPreview('com.example.trader~preview');

        expect(livePreview('com.example.trader~preview')).toBeNull();
        // The workspace index has to go too. A stale entry would keep answering
        // for a workspace id that teardown has already deleted, and the next
        // workspace to be handed that id would inherit an app's authority.
        expect(previewForWorkspace('preview-ws-1')).toBeNull();
        expect(listPreviews()).toEqual([]);
    });

    it('replaces a re-preview of the same app rather than stacking one beside it', () => {
        rememberPreview(preview(manifest(), 'preview-ws-1'));
        rememberPreview(preview(manifest(), 'preview-ws-2'));

        expect(listPreviews()).toHaveLength(1);
        expect(livePreview('com.example.trader~preview')?.workspaceId).toBe('preview-ws-2');
        // The first preview's workspace index must not survive its replacement.
        expect(previewForWorkspace('preview-ws-1')).toBeNull();
        expect(previewForWorkspace('preview-ws-2')).not.toBeNull();
    });

    it('holds previews of different apps side by side', () => {
        rememberPreview(preview(manifest(), 'preview-ws-1'));
        rememberPreview(
            preview(manifest({ id: 'com.example.other', slug: 'other' }), 'preview-ws-2'),
        );

        expect(listPreviews()).toHaveLength(2);
    });
});

describe('resolveAppGrant', () => {
    const installed: AppGrant = {
        appId: 'com.example.trader',
        appName: 'Example Trader',
        workspaceId: 'installed-ws',
        scope: 'self',
        capabilities: ['hosting', 'terminals'],
        revoked: false,
    };

    it('answers with the preview when the caller IS a preview', () => {
        const live = preview(manifest());

        const grant = resolveAppGrant('com.example.trader~preview', {
            preview: () => live,
            installed: () => installed,
        });

        // Even where an installed grant would have answered, the preview's own —
        // narrower, differently named, pointed at the preview's workspace — is
        // what a previewed window acts under.
        expect(grant).toBe(live.grant);
    });

    it('falls through to the installed grant for an ordinary app', () => {
        expect(
            resolveAppGrant('com.example.trader', {
                preview: () => null,
                installed: () => installed,
            }),
        ).toBe(installed);
    });

    it('fails closed when neither knows the caller', () => {
        expect(
            resolveAppGrant('com.example.ghost', {
                preview: () => null,
                installed: () => null,
            }),
        ).toBeNull();
    });
});
