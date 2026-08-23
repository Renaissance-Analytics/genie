import { describe, expect, it } from 'vitest';
import {
    PREVIEW_APP_KIND,
    isPreviewAppId,
    mayTearDownPreviewWorkspace,
    orphanedPreviewWorkspaces,
    previewGrant,
    previewIdentityFor,
    previewManifest,
} from '../preview';
import { validateAppManifest, type AppManifest } from '../manifest';

function manifest(over: Record<string, unknown> = {}): AppManifest {
    const parsed = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: ['hosting', 'terminals'] },
        ...over,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.value;
}

describe('previewIdentityFor', () => {
    it('serves a preview at a name no installed app can ever hold', () => {
        const identity = previewIdentityFor(manifest());

        // An installed slug is a single DNS LABEL — the manifest validator refuses
        // a dot — so a dotted preview name cannot collide with any installed app's
        // `<slug>.gen`, now or after any future install. That is the whole reason
        // the separator is a dot rather than a hyphen: `trader-preview` is a slug
        // somebody could legitimately register.
        expect(identity.slug).toBe('trader.preview');
        expect(validateAppManifest({ ...manifest(), slug: identity.slug }).ok).toBe(false);
    });

    it('keys storage on an id no manifest could declare', () => {
        const identity = previewIdentityFor(manifest());

        // The partition is derived from the app id, so a preview that could share
        // an id with an installed app could read its cookies. Reverse-DNS admits
        // only [a-z0-9.-], and the partition sanitiser turns anything else into
        // `_` — which is equally impossible in a real id. Collision-free by
        // construction rather than by hoping nobody picks the name.
        expect(identity.appId).toBe('com.example.trader~preview');
        expect(validateAppManifest({ ...manifest(), id: identity.appId }).ok).toBe(false);
        expect(isPreviewAppId(identity.appId)).toBe(true);
        expect(isPreviewAppId('com.example.trader')).toBe(false);
    });

    it('is stable, so re-previewing the same folder lands on the same storage', () => {
        expect(previewIdentityFor(manifest())).toEqual(previewIdentityFor(manifest()));
    });
});

describe('previewManifest', () => {
    it('wears the preview identity so every derived surface follows it', () => {
        const preview = previewManifest(manifest({ tabs: [{ title: 'Trade', path: '/trade' }] }));

        // `appWindowTabs` and `appPartitionFor` derive the origin and the partition
        // from the MANIFEST and from nothing else — deliberately, so there is only
        // one rule about where a tab points. Substituting the identity here keeps
        // that true: the preview does not need a second rule, it needs a different
        // manifest.
        expect(preview.slug).toBe('trader.preview');
        expect(preview.id).toBe('com.example.trader~preview');
    });

    it('changes nothing else — a preview of a different app would prove nothing', () => {
        const real = manifest({ panels: { agents: 3, kinds: ['terminal', 'files'] } });
        const preview = previewManifest(real);

        expect(preview.panels).toEqual(real.panels);
        expect(preview.frontend).toEqual(real.frontend);
        expect(preview.permissions).toEqual(real.permissions);
        expect(preview.name).toBe(real.name);
        expect(preview.version).toBe(real.version);
    });

    it('leaves the real manifest untouched', () => {
        const real = manifest();
        previewManifest(real);
        expect(real.slug).toBe('trader');
        expect(real.id).toBe('com.example.trader');
    });
});

describe('previewGrant', () => {
    it('cannot hold a capability the manifest never declared', () => {
        const grant = previewGrant(manifest(), previewIdentityFor(manifest()), 'ws-1', {
            scope: 'self',
            capabilities: ['hosting', 'secrets'],
        });

        // The same ceiling the permissions screen enforces. A preview is a faster
        // loop, not a wider one — nothing about not being installed makes it safe
        // to hold authority the developer never asked for.
        expect(grant.capabilities).toEqual(['hosting']);
    });

    it('acts as the PREVIEW app, so a call can never be attributed to the installed one', () => {
        const grant = previewGrant(manifest(), previewIdentityFor(manifest()), 'ws-1', {
            scope: 'self',
            capabilities: [],
        });

        expect(grant.appId).toBe('com.example.trader~preview');
        expect(grant.workspaceId).toBe('ws-1');
        expect(grant.revoked).toBe(false);
    });

    it('says it is a preview in the name the user will read', () => {
        const grant = previewGrant(manifest(), previewIdentityFor(manifest()), 'ws-1', {
            scope: 'self',
            capabilities: ['terminals'],
        });

        // `call-prep` stamps this name on anything the app puts in front of the
        // user — a ForceTheQuestion modal, an AgentInbox message. An unlabelled
        // preview would be indistinguishable from the installed app asking.
        expect(grant.appName).toBe('Example Trader (preview)');
    });

    it('cannot be widened past the scope the manifest declared', () => {
        const grant = previewGrant(
            manifest({ permissions: { scope: 'self', capabilities: [] } }),
            previewIdentityFor(manifest()),
            'ws-1',
            { scope: 'workstation', capabilities: [] },
        );

        expect(grant.scope).toBe('self');
    });
});

describe('tearing a preview down', () => {
    const row = (id: string, appKind: string | null) => ({ id, app_kind: appKind });

    it('refuses to remove a workspace it did not mark as a preview', () => {
        // The load-bearing assertion of the whole module. A preview's workspace
        // points at the DEVELOPER'S OWN FOLDER, and Genie may already have a real
        // workspace row on that same path. If teardown ever reached one of those,
        // closing a preview window would delete the developer's project from
        // Genie — so the row is checked, never trusted.
        expect(mayTearDownPreviewWorkspace(row('ws-1', PREVIEW_APP_KIND), 'ws-1')).toBe(true);
        expect(mayTearDownPreviewWorkspace(row('ws-1', 'app-dev'), 'ws-1')).toBe(false);
        expect(mayTearDownPreviewWorkspace(row('ws-1', 'app'), 'ws-1')).toBe(false);
        expect(mayTearDownPreviewWorkspace(row('ws-1', null), 'ws-1')).toBe(false);
    });

    it('refuses when the row is not the one this preview created', () => {
        expect(mayTearDownPreviewWorkspace(row('ws-2', PREVIEW_APP_KIND), 'ws-1')).toBe(false);
        expect(mayTearDownPreviewWorkspace(null, 'ws-1')).toBe(false);
    });

    it('treats every preview workspace still on disk at boot as dead', () => {
        // A preview cannot outlive its window, and a window cannot outlive the
        // process. So a preview workspace seen at startup is the residue of a
        // crash, and sweeping it is what keeps "closing the window is the whole
        // cleanup" true even when the window never got the chance to close.
        const rows = [
            row('real', null),
            row('installed', 'app'),
            row('dev', 'app-dev'),
            row('left-behind', PREVIEW_APP_KIND),
            row('also-left', PREVIEW_APP_KIND),
        ];

        expect(orphanedPreviewWorkspaces(rows)).toEqual(['left-behind', 'also-left']);
    });
});
