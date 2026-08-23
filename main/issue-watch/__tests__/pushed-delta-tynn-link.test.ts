import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * tynn.ai#134 — "Tynn isn't tracking this workspace yet" on a workspace Tynn IS
 * tracking.
 *
 * Tynn keys every `issuewatch.delta` — and the `/api/v1/user/issue-watch`
 * reconcile — by the TYNN PROJECT id (`IssueWatchDelta::broadcastWith()` sends
 * `workspaceId = (string) $project->id`). Genie keys every IssueWatch READ by the
 * LOCAL workspace id (`listWorkspaces()[].id`, the flyout's open workspace).
 *
 * Those two ids coincide only by CONSTRUCTION: the Add-workspace flow uses
 * `id := project.id` when a Tynn project was picked, and the assignment
 * provisioner uses `id := assignment.workspaceId`. A locally scaffolded `.agi`
 * envelope mints its OWN id and records its Tynn link in project.json
 * (`tynn.projectId`) — so its server snapshot landed in `pushedByWorkspace`
 * under an id nothing ever read, and the flyout rendered "not tracking" for a
 * healthy, actively-polled feed.
 *
 * These tests pin the resolution: a pushed delta is stored against the LOCAL
 * workspace it belongs to, resolved through the workspace's Tynn link.
 */

/** A locally scaffolded envelope: local id ≠ Tynn project id, linked in project.json. */
const LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iw134-linked-'));
/** An envelope explicitly UNLINKED (`tynn: {}` — the unlink marker). */
const UNLINKED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iw134-unlinked-'));

fs.writeFileSync(
    path.join(LOCAL_DIR, 'project.json'),
    JSON.stringify({
        name: 'prism',
        tynn: { host: 'https://tynn.ai', project: 'prism', projectId: 'PRJ-PRISM' },
    }),
);
fs.writeFileSync(
    path.join(UNLINKED_DIR, 'project.json'),
    JSON.stringify({ name: 'solo', tynn: {} }),
);

/** id ≠ project id, and the row's own project_id/tynn_project_id are EMPTY —
 *  exactly the live Prism row (`('MR8GJF5KPJY11N560000', '', 'Prism', …)`). */
const LINKED_WS = {
    id: 'local-prism-id',
    backend: 'tynn',
    path: LOCAL_DIR,
    project_id: '',
    tynn_project_id: '',
    tynn_project_name: '',
};
/** The common case: created FROM a Tynn project, so id === project id. */
const SAME_ID_WS = {
    id: 'PRJ-TYNN',
    backend: 'tynn',
    path: path.join(os.tmpdir(), 'iw134-missing-project-json'),
    project_id: 'PRJ-TYNN',
    tynn_project_id: 'PRJ-TYNN',
    tynn_project_name: 'Tynn.ai',
};
const UNLINKED_WS = {
    id: 'local-solo-id',
    backend: 'tynn',
    path: UNLINKED_DIR,
    project_id: '',
    tynn_project_id: '',
    tynn_project_name: '',
};
const ROWS = [LINKED_WS, SAME_ID_WS, UNLINKED_WS];

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
}));
vi.mock('simple-git', () => ({ default: () => ({ getRemotes: async () => [] }) }));
vi.mock('../../db', () => ({
    getWorkspace: (id: string) => ROWS.find((r) => r.id === id),
    listIssueWatches: () => [],
    listWorkspaces: () => ROWS,
    setIssueWatch: () => {},
    markIssueWatchSeen: () => {},
    getWorkspaceIssuewatchGranularity: () => ({
        own: { issues: true, pulls: true, security: true },
        upstream: 'none',
    }),
    getWorkspaceIssuewatchHandlers: () => [],
    listWorkspaceIssuewatchAgents: () => [],
    getForkUpstream: () => undefined,
    setForkUpstream: () => {},
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../github/api', () => ({
    fetchRepoWatchItemsResult: async () => ({ items: [], error: null, detail: null }),
    fetchUpstreamWatchItems: async () => ({ items: [], error: null, detail: null }),
    getRepoMetadata: async () => ({ owner: { login: 'o' }, fork: false, upstream: null }),
    isSecurityKind: (k: string) => k.startsWith('dependabot'),
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
vi.mock('../../remote', () => ({ broadcastLocal: () => {} }));
vi.mock('../../mobile/bus', () => ({ mobileEmit: () => {} }));

import {
    applyPushedDelta,
    clearPushedDelta,
    getOpenCounts,
    getWorkspaceFeed,
    getWorkspaceStatus,
    isServerFed,
    setIssueWatchServiceState,
    setReconcileDelivered,
} from '../index';

const delta = (workspaceId: string) => ({
    workspaceId,
    counts: { issue: 2, pr: 1, security: 0, feedback: 0 },
    items: [
        {
            kind: 'issue' as const,
            key: 'Particle-Academy/prism:issue:7',
            number: 7,
            title: 'Prism trace export drops spans',
            url: 'https://github.com/Particle-Academy/prism/issues/7',
            updatedAt: '2026-07-24T00:00:00Z',
            owner: 'Particle-Academy',
            repo: 'prism',
            source: 'own' as const,
            unread: true,
        },
    ],
});

beforeEach(() => {
    for (const r of ROWS) clearPushedDelta(r.id);
    clearPushedDelta('PRJ-PRISM');
    setReconcileDelivered(false);
    setIssueWatchServiceState('connecting');
});

describe('server delta ↔ local workspace id resolution (tynn.ai#134)', () => {
    it('marks a project.json-LINKED workspace known-to-server when the delta arrives under the TYNN PROJECT id', async () => {
        applyPushedDelta(delta('PRJ-PRISM'));

        const status = await getWorkspaceStatus(LINKED_WS.id);
        expect(status.connected).toBe(true);
        expect(status.knownToServer).toBe(true);
    });

    it('serves the pushed feed + counts under the LOCAL workspace id', async () => {
        applyPushedDelta(delta('PRJ-PRISM'));

        expect(isServerFed(LINKED_WS.id)).toBe(true);
        const feed = await getWorkspaceFeed(LINKED_WS.id);
        expect(feed.map((i) => i.key)).toEqual(['Particle-Academy/prism:issue:7']);
        const counts = await getOpenCounts();
        expect(counts[LINKED_WS.id]).toMatchObject({
            issue: 2,
            pr: 1,
            security: 0,
            feedback: 0,
            knownToServer: true,
        });
    });

    it('still resolves a workspace whose local id IS the Tynn project id', async () => {
        applyPushedDelta(delta(SAME_ID_WS.id));

        expect(isServerFed(SAME_ID_WS.id)).toBe(true);
        expect((await getWorkspaceStatus(SAME_ID_WS.id)).knownToServer).toBe(true);
    });

    it('clears a linked workspace when the server drops it by Tynn project id', async () => {
        applyPushedDelta(delta('PRJ-PRISM'));
        expect(isServerFed(LINKED_WS.id)).toBe(true);

        clearPushedDelta('PRJ-PRISM');

        expect(isServerFed(LINKED_WS.id)).toBe(false);
        expect((await getWorkspaceStatus(LINKED_WS.id)).knownToServer).toBe(false);
    });

    it('never claims an explicitly UNLINKED envelope (project.json `tynn: {}`) for a stray delta', async () => {
        applyPushedDelta(delta('PRJ-PRISM'));

        expect(isServerFed(UNLINKED_WS.id)).toBe(false);
        expect((await getWorkspaceStatus(UNLINKED_WS.id)).knownToServer).toBe(false);
    });
});
