import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * A workspace the SERVER has never heard of must not look identical to a quiet one.
 *
 * THE BUG (genie#22 / tynn.ai#105): the reconcile returning `{"workspaces": []}`
 * sets `reconcileDelivered = true` — zero rows counted as authoritative delivery.
 * `getWorkspaceStatus` then reported `{connected: true, error: null}` for EVERY
 * workspace, including ones the server never mentioned, and the flyout rendered a
 * confident "Nothing open on the watched repos".
 *
 * That is why a totally dead feed went undiagnosed: broken and quiet were the same
 * pixels. These tests pin the distinction so it can't regress into silence again.
 */

const WS = { id: 'ws-1', path: '/ws/demo.agi' };

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
}));
vi.mock('simple-git', () => ({
    default: () => ({ getRemotes: async () => [] }),
}));
vi.mock('../../db', () => ({
    getWorkspace: () => WS,
    listIssueWatches: () => [],
    listWorkspaces: () => [WS],
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
    getWorkspaceIssuewatchGranularity: () => ({
        own: { issues: true, pulls: true, security: true },
        upstream: 'none',
    }),
    getForkUpstream: () => undefined,
    setForkUpstream: () => {},
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../github/api', () => ({
    fetchRepoWatchItemsResult: async () => ({ items: [], error: null, detail: null }),
    fetchUpstreamWatchItems: async () => ({ items: [], error: null, detail: null }),
    getRepoMetadata: async () => ({ owner: { login: 'o', id: null, isOrg: false }, fork: false, upstream: null }),
    parseGitHubRemote: () => null,
    worseError: (a: string | null, b: string | null) => a ?? b,
}));
vi.mock('../../github/storage', () => ({ getToken: () => null, needsReauth: () => false }));
vi.mock('../../github/capability-service', () => ({
    getCapabilities: () => ({
        connected: false,
        satisfiedFeatures: [],
        missing: [],
        missingPermissions: [],
        missingByPermission: [],
        appPermissionsUrl: '',
        checked: true,
    }),
}));

import {
    applyPushedDelta,
    clearPushedDelta,
    getWorkspaceStatus,
    setIssueWatchServiceState,
    setReconcileDelivered,
} from '../index';

beforeEach(() => {
    clearPushedDelta('ws-1');
    setIssueWatchServiceState('disconnected');
    setReconcileDelivered(false);
});

describe('workspace the server does not know about', () => {
    it('is NOT reported as a healthy connected workspace', async () => {
        // The exact production shape: the stream is up and the reconcile came back
        // 200 — but it listed zero workspaces, so nothing was ever pushed for ws-1.
        setIssueWatchServiceState('connected');
        setReconcileDelivered(true);

        const status = await getWorkspaceStatus('ws-1');

        // Previously: {connected: true} → flyout said "Nothing open". The whole
        // point of this fix is that this workspace is distinguishable.
        expect(status.knownToServer).toBe(false);
    });

    it('is distinguishable from a workspace that genuinely has nothing open', async () => {
        setIssueWatchServiceState('connected');
        setReconcileDelivered(true);
        const unknown = await getWorkspaceStatus('ws-1');

        // Now the server DOES report it — with zero open items. Genuinely quiet.
        applyPushedDelta({
            workspaceId: 'ws-1',
            counts: { issue: 0, pr: 0, security: 0 },
            items: [],
        });
        const quiet = await getWorkspaceStatus('ws-1');

        // Both are empty. They must NOT be the same status.
        expect(quiet.knownToServer).toBe(true);
        expect(unknown.knownToServer).toBe(false);
        expect(quiet.knownToServer).not.toBe(unknown.knownToServer);
    });

    it('still reports connected once the workspace is known', async () => {
        // Guard: the new flag must not regress the existing connected signal.
        setIssueWatchServiceState('connected');
        setReconcileDelivered(true);
        applyPushedDelta({
            workspaceId: 'ws-1',
            counts: { issue: 1, pr: 0, security: 0 },
            items: [],
        });

        const status = await getWorkspaceStatus('ws-1');
        expect(status.connected).toBe(true);
        expect(status.knownToServer).toBe(true);
    });

    it('reports knownToServer false while the stream is still down', async () => {
        // A disconnected stream is already surfaced via `connected: false`; the new
        // flag must not claim knowledge we don't have.
        const status = await getWorkspaceStatus('ws-1');
        expect(status.connected).toBe(false);
        expect(status.knownToServer).toBe(false);
    });
});
