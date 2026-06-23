import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Capability SERVICE detection logic: how recheckCapabilities reads the token +
 * installation permissions and turns them into the cached status the IPC /
 * gate / renderer consume. The network read + token are mocked; the assertions
 * are on the computed status (connected/missing/satisfied) and the inert
 * disconnected behaviour.
 */

const store = {
    token: 'tok' as string | null,
    perInstallation: [] as Record<string, string>[],
    readThrows: false,
};

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
    readGrantedPermissions: async () => {
        if (store.readThrows) throw new Error('network');
        return store.perInstallation;
    },
}));

import {
    getCapabilities,
    recheckCapabilities,
    canAccessCapability,
} from '../capability-service';

beforeEach(() => {
    store.token = 'tok';
    store.perInstallation = [];
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
        // Inert gate: a gated capability still resolves accessible so the
        // feature's own not-connected handling runs instead of a permission
        // warning.
        expect(await canAccessCapability('github.provision')).toBe(true);
    });
});

describe('recheckCapabilities — connected', () => {
    it('computes missing=contents for the genie-ide-style grant set', async () => {
        store.perInstallation = [
            {
                metadata: 'read',
                issues: 'read',
                pull_requests: 'read',
                vulnerability_alerts: 'read',
                administration: 'write',
            },
        ];
        const caps = await recheckCapabilities();
        expect(caps.connected).toBe(true);
        expect(caps.missing).toEqual(['github.provision']);
        expect(caps.missingPermissions).toEqual(['contents']);
        // The gate now denies provisioning but allows the issue-watch reads.
        expect(await canAccessCapability('github.provision')).toBe(false);
        expect(await canAccessCapability('issue-watch.issues')).toBe(true);
    });

    it('marks everything satisfied when contents:write is also granted', async () => {
        store.perInstallation = [
            {
                metadata: 'read',
                issues: 'read',
                pull_requests: 'read',
                vulnerability_alerts: 'read',
                contents: 'write',
            },
        ];
        const caps = await recheckCapabilities();
        expect(caps.missing).toEqual([]);
        expect(await canAccessCapability('github.provision')).toBe(true);
    });

    it('keeps the prior snapshot on a transient read failure', async () => {
        // First, a good read establishes a known-good snapshot.
        store.perInstallation = [
            { metadata: 'read', issues: 'read', pull_requests: 'read', vulnerability_alerts: 'read', contents: 'write' },
        ];
        await recheckCapabilities();
        expect(getCapabilities().missing).toEqual([]);

        // Now the next read throws — we must NOT flip every gated feature off.
        store.readThrows = true;
        const caps = await recheckCapabilities();
        expect(caps.connected).toBe(true);
        expect(caps.missing).toEqual([]); // unchanged from the prior good read
    });
});
