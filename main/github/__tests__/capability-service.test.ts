import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Capability SERVICE detection logic: how recheckCapabilities reads the token +
 * installation permissions and turns them into the cached status the IPC /
 * gate / renderer consume. The network read + token are mocked; the assertions
 * are on the computed status (connected/missing/satisfied) and the inert
 * disconnected behaviour.
 */

interface MockInstall {
    login: string;
    id: number | null;
    installationId: number | null;
    isOrg: boolean;
    permissions: Record<string, string>;
}

const store = {
    token: 'tok' as string | null,
    /** Installations the mocked api returns; each carries identity + grants. */
    installations: [] as MockInstall[],
    readThrows: false,
};

/** Convenience: build the install list from bare permission maps (one personal
 *  install per map) for the tests that only care about the aggregate. */
function installsFromPerms(perms: Record<string, string>[]): MockInstall[] {
    return perms.map((p, i) => ({
        login: `acct-${i}`,
        id: i + 1,
        installationId: 1000 + i,
        isOrg: false,
        permissions: p,
    }));
}

vi.mock('electron', () => ({
    // BrowserWindow.getAllWindows() is only used by broadcast; an empty list
    // means broadcasts are no-ops in the test.
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: vi.fn() },
}));
vi.mock('../storage', () => ({
    getToken: () => store.token,
}));
vi.mock('../api', () => ({
    readInstallationGrants: async () => {
        if (store.readThrows) throw new Error('network');
        return store.installations;
    },
}));

import {
    getCapabilities,
    recheckCapabilities,
    canAccessCapability,
} from '../capability-service';

beforeEach(() => {
    store.token = 'tok';
    store.installations = [];
    store.readThrows = false;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('recheckCapabilities — disconnected', () => {
    it('reports connected:false and treats the gate as inert (all satisfied)', async () => {
        store.token = null;
        const caps = await recheckCapabilities();
        expect(caps.connected).toBe(false);
        expect(caps.checked).toBe(true);
        expect(caps.missing).toEqual([]);
        expect(caps.missingByPermission).toEqual([]);
        // Inert gate: a gated capability still resolves accessible so the
        // feature's own not-connected handling runs instead of a permission
        // warning.
        expect(await canAccessCapability('github.provision')).toBe(true);
    });
});

describe('recheckCapabilities — connected', () => {
    it('computes missing=contents for the genie-ide-style grant set', async () => {
        store.installations = installsFromPerms([
            {
                metadata: 'read',
                issues: 'read',
                pull_requests: 'read',
                vulnerability_alerts: 'read',
                administration: 'write',
            },
        ]);
        const caps = await recheckCapabilities();
        expect(caps.connected).toBe(true);
        expect(caps.missing).toEqual(['github.provision']);
        expect(caps.missingPermissions).toEqual(['contents']);
        // The gate now denies provisioning but allows the issue-watch reads.
        expect(await canAccessCapability('github.provision')).toBe(false);
        expect(await canAccessCapability('issue-watch.issues')).toBe(true);
    });

    it('attributes the missing permission to the specific installs + a review URL', async () => {
        // Two installs: a personal one that DOESN'T grant contents and an org
        // one that also doesn't — both must be listed for `contents`, each with
        // its own review deep-link (org variant for the org install).
        // Both installs grant the issue-watch perms but NOT contents, so the
        // only missing permission is `contents` — isolating the attribution.
        const issueWatchPerms = {
            metadata: 'read',
            issues: 'read',
            pull_requests: 'read',
            vulnerability_alerts: 'read',
        };
        store.installations = [
            {
                login: 'wishborn',
                id: 1,
                installationId: 1001,
                isOrg: false,
                permissions: { ...issueWatchPerms },
            },
            {
                login: 'Renaissance-Analytics',
                id: 2,
                installationId: 2002,
                isOrg: true,
                permissions: { ...issueWatchPerms },
            },
        ];
        const caps = await recheckCapabilities();
        expect(caps.missingPermissions).toEqual(['contents']);
        // App-permission-settings deep-link (where the OWNER adds the perm).
        expect(caps.appPermissionsUrl).toBe(
            'https://github.com/settings/apps/genie-ide/permissions',
        );
        const group = caps.missingByPermission.find(
            (g) => g.permission === 'contents',
        );
        expect(group?.installations.map((i) => i.login)).toEqual([
            'wishborn',
            'Renaissance-Analytics',
        ]);
        // Personal install → settings/installations/<installationId>.
        expect(group?.installations[0].reviewUrl).toBe(
            'https://github.com/settings/installations/1001',
        );
        // Org install → org-owned variant keyed by the installation id.
        expect(group?.installations[1].reviewUrl).toBe(
            'https://github.com/organizations/Renaissance-Analytics/settings/installations/2002',
        );
    });

    it('lists only the NON-granting install when another install satisfies the aggregate', async () => {
        // Org grants contents:write → aggregate satisfied → nothing missing.
        store.installations = [
            {
                login: 'wishborn',
                id: 1,
                installationId: 1001,
                isOrg: false,
                permissions: { metadata: 'read', issues: 'read' },
            },
            {
                login: 'Renaissance-Analytics',
                id: 2,
                installationId: 2002,
                isOrg: true,
                permissions: {
                    metadata: 'read',
                    issues: 'read',
                    pull_requests: 'read',
                    vulnerability_alerts: 'read',
                    contents: 'write',
                },
            },
        ];
        const caps = await recheckCapabilities();
        expect(caps.missing).toEqual([]);
        expect(caps.missingByPermission).toEqual([]);
    });

    it('marks everything satisfied when contents:write is also granted', async () => {
        store.installations = installsFromPerms([
            {
                metadata: 'read',
                issues: 'read',
                pull_requests: 'read',
                vulnerability_alerts: 'read',
                contents: 'write',
            },
        ]);
        const caps = await recheckCapabilities();
        expect(caps.missing).toEqual([]);
        expect(await canAccessCapability('github.provision')).toBe(true);
    });

    it('keeps the prior snapshot on a transient read failure', async () => {
        // First, a good read establishes a known-good snapshot.
        store.installations = installsFromPerms([
            { metadata: 'read', issues: 'read', pull_requests: 'read', vulnerability_alerts: 'read', contents: 'write' },
        ]);
        await recheckCapabilities();
        expect(getCapabilities().missing).toEqual([]);

        // Now the next read throws — we must NOT flip every gated feature off.
        store.readThrows = true;
        const caps = await recheckCapabilities();
        expect(caps.connected).toBe(true);
        expect(caps.missing).toEqual([]); // unchanged from the prior good read
    });
});
