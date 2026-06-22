import { describe, expect, it, vi, beforeEach } from 'vitest';

// computeOpsRepoPlan needs db / backend / git / project-json / link mocked.
// diffOpsRepos is pure and imported directly below.

let workspaceRows: Array<{ path: string; tynn_project_id?: string }> = [];
let slaves: Array<{ id: string; name: string; slug: string; owner_name: string | null; owner_slug: string | null }> = [];
let isOpsProject = true;
let signedIn = true;
let linkByPath: Record<string, { projectId: string } | null> = {};
let originByPath: Record<string, string | null> = {};
let envelopeRepos: Array<{ name: string; url?: string; managedByOps?: boolean }> = [];

const OPS_WS = '/ws/ops.agi';

vi.mock('../../db', () => ({ listWorkspaces: () => workspaceRows }));
vi.mock('../../backend/tynn', () => ({
    TynnBackend: class {
        async whoami() {
            return signedIn ? { id: 'u1', name: 'U', email: 'u@x' } : null;
        }
        async opsSlaves() {
            return { isOpsProject, slaves };
        }
    },
}));
vi.mock('simple-git', () => ({
    simpleGit: (p: string) => ({
        getConfig: async () => ({ value: originByPath[p] ?? null }),
    }),
}));
vi.mock('../../workspace/project-json', () => ({
    readProjectJson: () => ({ repos: envelopeRepos }),
    writeProjectJson: vi.fn(),
}));
vi.mock('../provision', () => ({
    readTynnLink: (p: string) =>
        p === OPS_WS ? { projectId: 'ops-1' } : (linkByPath[p] ?? null),
}));

import { diffOpsRepos, computeOpsRepoPlan } from '../ops-repos';

beforeEach(() => {
    workspaceRows = [];
    slaves = [];
    isOpsProject = true;
    signedIn = true;
    linkByPath = {};
    originByPath = {};
    envelopeRepos = [];
});

describe('diffOpsRepos', () => {
    const desired = [
        { name: 'civi-web', url: 'git@github.com:o/civi-web.agi.git', projectId: 'p1' },
        { name: 'civi-api', url: 'git@github.com:o/civi-api.agi.git', projectId: 'p2' },
    ];

    it('adds desired slave repos not yet in the envelope', () => {
        const { toAdd, toRemove } = diffOpsRepos(desired, []);
        expect(toAdd.map((r) => r.name)).toEqual(['civi-web', 'civi-api']);
        expect(toRemove).toEqual([]);
    });

    it('matches by URL, not name (a present repo is not re-added)', () => {
        const current = [
            { name: 'renamed', url: 'git@github.com:o/civi-web.agi.git', managedByOps: true },
        ];
        const { toAdd } = diffOpsRepos(desired, current);
        expect(toAdd.map((r) => r.name)).toEqual(['civi-api']);
    });

    it('removes only managedByOps repos that are no longer desired', () => {
        const current = [
            { name: 'civi-web', url: 'git@github.com:o/civi-web.agi.git', managedByOps: true },
            { name: 'dropped', url: 'git@github.com:o/dropped.agi.git', managedByOps: true },
            { name: 'hand-added', url: 'git@github.com:o/manual.git' }, // not managedByOps
        ];
        const { toAdd, toRemove } = diffOpsRepos(desired, current);
        expect(toRemove.map((r) => r.name)).toEqual(['dropped']); // not 'hand-added'
        expect(toAdd.map((r) => r.name)).toEqual(['civi-api']);
    });

    it('never touches hand-added (non-managed) repos', () => {
        const current = [{ name: 'manual', url: 'git@github.com:o/manual.git' }];
        const { toRemove } = diffOpsRepos([], current);
        expect(toRemove).toEqual([]);
    });
});

describe('computeOpsRepoPlan — presence keyed off the workspace row', () => {
    it('resolves a slave repo via the workspace ROW tynn_project_id (project.json has no link)', async () => {
        slaves = [
            { id: 's1', name: 'Child One', slug: 'child-one', owner_name: 'Civicognita Operations', owner_slug: 'civicognita' },
        ];
        workspaceRows = [{ path: '/ws/child-one.agi', tynn_project_id: 's1' }];
        linkByPath = { '/ws/child-one.agi': null }; // no project.json tynn link
        originByPath = { '/ws/child-one.agi': 'git@github.com:civicognita/child-one.agi.git' };

        const plan = await computeOpsRepoPlan(OPS_WS);
        // Resolved locally → desired (toAdd), NOT reported missingLocally.
        expect(plan.missingLocally).toEqual([]);
        expect(plan.toAdd.map((r) => r.url)).toContain(
            'git@github.com:civicognita/child-one.agi.git',
        );
    });

    it('reports a slave missingLocally when no workspace row matches its id', async () => {
        slaves = [
            { id: 's2', name: 'Child Two', slug: 'child-two', owner_name: 'Civicognita', owner_slug: 'civicognita' },
        ];
        workspaceRows = []; // nothing local

        const plan = await computeOpsRepoPlan(OPS_WS);
        expect(plan.missingLocally.map((m) => m.projectId)).toEqual(['s2']);
        expect(plan.toAdd).toEqual([]);
    });
});
