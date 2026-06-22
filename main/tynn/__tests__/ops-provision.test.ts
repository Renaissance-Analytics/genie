import { describe, expect, it, vi, beforeEach } from 'vitest';

// Pure-function tests import directly. The computeOpsProvisionPlan tests need
// the db / backend / link modules mocked, so we drive those through module
// mocks declared up top (hoisted by vitest) and tweak per-test state.

let workspaceRows: Array<{ path: string; tynn_project_id?: string }> = [];
let settings: Record<string, string> = {};
let slaves: Array<{
    id: string;
    name: string;
    slug: string;
    owner_name: string | null;
    owner_slug: string | null;
}> = [];
let isOpsProject = true;
let signedIn = true;
// Tynn link (project.json `tynn` block) keyed by workspace path. The ROW's
// tynn_project_id is the primary presence signal; this is the fallback.
let linkByPath: Record<string, { projectId: string } | null> = {};

vi.mock('../../db', () => ({
    listWorkspaces: () => workspaceRows,
    getAllSettings: () => settings,
    addWorkspace: vi.fn(),
}));
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
vi.mock('../../workspace/create-agi', () => ({
    cloneAgiEnvelope: vi.fn(),
}));
vi.mock('../provision', () => ({
    // ops-provision links the OPS workspace itself + reads each ws's link.
    readTynnLink: (p: string) =>
        p === OPS_WS ? { projectId: 'ops-1' } : (linkByPath[p] ?? null),
}));

import {
    childAgiCloneUrl,
    computeOpsProvisionPlan,
    provisionTargets,
    type OpsProvisionPlan,
} from '../ops-provision';

const OPS_WS = '/ws/ops.agi';

beforeEach(() => {
    workspaceRows = [];
    settings = {};
    slaves = [];
    isOpsProject = true;
    signedIn = true;
    linkByPath = {};
});

describe('childAgiCloneUrl', () => {
    it('builds a valid github *.agi url from the owner SLUG + project slug', () => {
        expect(childAgiCloneUrl('civicognita', 'civi-web')).toBe(
            'https://github.com/civicognita/civi-web.agi.git',
        );
    });

    it('yields a URL with no spaces even when slugs are clean (regression: display name had spaces)', () => {
        const url = childAgiCloneUrl('civicognita', 'civi-web');
        expect(url).not.toContain(' ');
        expect(url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.agi\.git$/);
    });

    it('returns null without a usable owner (cannot guess a URL)', () => {
        expect(childAgiCloneUrl(null, 'civi-web')).toBeNull();
        expect(childAgiCloneUrl(undefined, 'civi-web')).toBeNull();
        expect(childAgiCloneUrl('', 'civi-web')).toBeNull();
        expect(childAgiCloneUrl('   ', 'civi-web')).toBeNull();
    });

    it('returns null without a slug', () => {
        expect(childAgiCloneUrl('civicognita', '')).toBeNull();
    });
});

describe('provisionTargets', () => {
    const plan = (children: OpsProvisionPlan['children']): OpsProvisionPlan => ({
        isOps: true,
        signedIn: true,
        children,
        parentPath: '/parent',
        autoProvision: false,
    });

    it('returns only missing children that have a resolvable clone URL', () => {
        const targets = provisionTargets(
            plan([
                {
                    projectId: 'p1',
                    name: 'Present One',
                    slug: 'present-one',
                    status: 'present',
                    cloneUrl: null,
                    workspacePath: '/ws/present-one.agi',
                },
                {
                    projectId: 'p2',
                    name: 'Missing Two',
                    slug: 'missing-two',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/missing-two.agi.git',
                },
                {
                    projectId: 'p3',
                    name: 'Missing No URL',
                    slug: 'missing-no-url',
                    status: 'missing',
                    cloneUrl: null,
                },
            ]),
        );
        expect(targets).toEqual([
            {
                projectId: 'p2',
                name: 'Missing Two',
                slug: 'missing-two',
                cloneUrl: 'https://github.com/o/missing-two.agi.git',
            },
        ]);
    });

    it('returns nothing when every governed child already has a workspace', () => {
        const targets = provisionTargets(
            plan([
                {
                    projectId: 'p1',
                    name: 'Present',
                    slug: 'present',
                    status: 'present',
                    cloneUrl: null,
                },
            ]),
        );
        expect(targets).toEqual([]);
    });
});

describe('computeOpsProvisionPlan — presence + clone URL', () => {
    it('marks a child PRESENT when a workspace ROW tynn_project_id matches the slave id', async () => {
        slaves = [
            { id: 's1', name: 'Child One', slug: 'child-one', owner_name: 'Civicognita Operations', owner_slug: 'civicognita' },
        ];
        // The row carries the link via tynn_project_id; its project.json has NO
        // tynn link (the bug: readTynnLink alone would report it missing).
        workspaceRows = [{ path: '/ws/child-one.agi', tynn_project_id: 's1' }];
        linkByPath = { '/ws/child-one.agi': null };

        const plan = await computeOpsProvisionPlan(OPS_WS);
        const child = plan.children.find((c) => c.projectId === 's1');
        expect(child?.status).toBe('present');
        expect(child?.workspacePath).toBe('/ws/child-one.agi');
        expect(child?.cloneUrl).toBeNull();
    });

    it('falls back to the project.json link when the row lacks tynn_project_id', async () => {
        slaves = [
            { id: 's1', name: 'Child One', slug: 'child-one', owner_name: 'Civicognita', owner_slug: 'civicognita' },
        ];
        workspaceRows = [{ path: '/ws/child-one.agi' }]; // no row field
        linkByPath = { '/ws/child-one.agi': { projectId: 's1' } };

        const plan = await computeOpsProvisionPlan(OPS_WS);
        expect(plan.children.find((c) => c.projectId === 's1')?.status).toBe('present');
    });

    it('marks a child MISSING (with a valid owner-slug clone URL) when no workspace matches', async () => {
        slaves = [
            { id: 's2', name: 'Child Two', slug: 'child-two', owner_name: 'Civicognita Operations', owner_slug: 'civicognita' },
        ];
        workspaceRows = []; // nothing local

        const plan = await computeOpsProvisionPlan(OPS_WS);
        const child = plan.children.find((c) => c.projectId === 's2');
        expect(child?.status).toBe('missing');
        // Built from the owner SLUG, not the display name → valid, no spaces.
        expect(child?.cloneUrl).toBe('https://github.com/civicognita/child-two.agi.git');
        expect(child?.cloneUrl).not.toContain(' ');
    });

    it('marks a child MISSING with a null clone URL when the owner slug is absent', async () => {
        slaves = [
            { id: 's3', name: 'Child Three', slug: 'child-three', owner_name: 'Orphan', owner_slug: null },
        ];
        workspaceRows = [];

        const plan = await computeOpsProvisionPlan(OPS_WS);
        const child = plan.children.find((c) => c.projectId === 's3');
        expect(child?.status).toBe('missing');
        expect(child?.cloneUrl).toBeNull();
    });
});
