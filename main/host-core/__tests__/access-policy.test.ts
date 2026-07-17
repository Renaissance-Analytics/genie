import { describe, expect, it } from 'vitest';
import {
    ownerAccessPolicy,
    policyAllowsSite,
    policyAllowsTransport,
    policyAllowsWorkspace,
    visibleWorkspaceIds,
    type HostAccessPolicy,
} from '../access-policy';

const shared: HostAccessPolicy = {
    principalId: 'member-1',
    principalType: 'tynn-user',
    transports: ['tynn'],
    capability: 'readonly',
    workspaceScopes: ['workspace:ws-1'],
    sitePermissions: {
        'site-docs': 'browse',
        'site-app': 'interact',
    },
};

describe('host access policy', () => {
    it('gives the local owner immutable full authority', () => {
        const owner = ownerAccessPolicy();
        expect(policyAllowsTransport(owner, 'lan').allowed).toBe(true);
        expect(policyAllowsWorkspace(owner, 'anything', true).allowed).toBe(true);
        expect(
            policyAllowsSite(owner, {
                workspaceId: 'anything',
                siteId: 'anything',
                method: 'POST',
                websocket: true,
            }).allowed,
        ).toBe(true);
    });

    it('intersects transport, workspace and capability', () => {
        expect(policyAllowsTransport(shared, 'tynn').allowed).toBe(true);
        expect(policyAllowsTransport(shared, 'tailscale').allowed).toBe(false);
        expect(policyAllowsWorkspace(shared, 'ws-1').allowed).toBe(true);
        expect(policyAllowsWorkspace(shared, 'ws-2').allowed).toBe(false);
        expect(policyAllowsWorkspace(shared, 'ws-1', true).allowed).toBe(false);
        expect([...visibleWorkspaceIds(shared, ['ws-1', 'ws-2'])]).toEqual(['ws-1']);
    });

    it('keeps sites explicit and distinguishes browse from interact', () => {
        expect(
            policyAllowsSite(shared, {
                workspaceId: 'ws-1',
                siteId: 'unknown',
                method: 'GET',
            }).allowed,
        ).toBe(false);
        expect(
            policyAllowsSite(shared, {
                workspaceId: 'ws-1',
                siteId: 'site-docs',
                method: 'GET',
            }).allowed,
        ).toBe(true);
        expect(
            policyAllowsSite(shared, {
                workspaceId: 'ws-1',
                siteId: 'site-docs',
                method: 'POST',
            }).allowed,
        ).toBe(false);
        expect(
            policyAllowsSite(shared, {
                workspaceId: 'ws-1',
                siteId: 'site-app',
                websocket: true,
            }).allowed,
        ).toBe(true);
    });

    it('fails every access check after local revocation', () => {
        const revoked = { ...shared, revokedAt: Date.now() };
        expect(policyAllowsTransport(revoked, 'tynn').allowed).toBe(false);
        expect(policyAllowsWorkspace(revoked, 'ws-1').allowed).toBe(false);
        expect(
            policyAllowsSite(revoked, {
                workspaceId: 'ws-1',
                siteId: 'site-app',
            }).allowed,
        ).toBe(false);
    });
});

