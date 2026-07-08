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
    repo_owner?: string | null;
    repo_name?: string | null;
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
    classifyGitRemoteError,
    computeOpsProvisionPlan,
    describeCloneFailure,
    parseEnvelopeUrl,
    provisionTargets,
    scaffoldTargets,
    type ChildRemoteState,
    type OpsProvisionPlan,
} from '../ops-provision';

const OPS_WS = '/ws/ops.agi';

/** Deterministic probe for plan tests — no real `git ls-remote` in vitest. */
const probeExists = async (): Promise<ChildRemoteState> => 'exists';

beforeEach(() => {
    workspaceRows = [];
    settings = {};
    slaves = [];
    isOpsProject = true;
    signedIn = true;
    linkByPath = {};
});

describe('childAgiCloneUrl', () => {
    it('builds the *.agi url from the PRIMARY repo owner + name when present', () => {
        // Reporter's case: project slug is `wishswonderscom` but the primary
        // repo is Renaissance-Analytics/wondermill — the envelope lives beside
        // the repo, so the URL uses the repo owner + name, not the slug.
        expect(
            childAgiCloneUrl({
                ownerSlug: 'renaissance-analytics',
                slug: 'wishswonderscom',
                repoOwner: 'Renaissance-Analytics',
                repoName: 'wondermill',
            }),
        ).toBe('https://github.com/Renaissance-Analytics/wondermill.agi.git');
    });

    it('falls back to the owner SLUG + project slug when there is no primary repo', () => {
        expect(
            childAgiCloneUrl({ ownerSlug: 'civicognita', slug: 'civi-web' }),
        ).toBe('https://github.com/civicognita/civi-web.agi.git');
        // Null repo fields are treated the same as absent (no primary repo).
        expect(
            childAgiCloneUrl({
                ownerSlug: 'civicognita',
                slug: 'civi-web',
                repoOwner: null,
                repoName: null,
            }),
        ).toBe('https://github.com/civicognita/civi-web.agi.git');
    });

    it('does not double the .agi suffix when the primary repo name already carries it', () => {
        // Real bug hit live 2026-07-08 (Tynn side, mirrored here): a primary repo
        // registered directly AS the .agi envelope repo (not a separate code repo
        // with an implied sibling) produced an invalid `foo.agi.agi.git` clone
        // target that silently failed to clone.
        expect(
            childAgiCloneUrl({
                ownerSlug: 'moic',
                slug: 'moic-suite',
                repoOwner: 'MOIC-Partners',
                repoName: 'moic-suite.agi',
            }),
        ).toBe('https://github.com/MOIC-Partners/moic-suite.agi.git');

        // Same guard on the fallback (owner-slug + project-slug) path.
        expect(
            childAgiCloneUrl({ ownerSlug: 'moic', slug: 'moic-suite.agi' }),
        ).toBe('https://github.com/moic/moic-suite.agi.git');
    });

    it('falls back when only ONE of repo owner / name is present', () => {
        expect(
            childAgiCloneUrl({
                ownerSlug: 'civicognita',
                slug: 'civi-web',
                repoOwner: 'Renaissance-Analytics',
                repoName: null,
            }),
        ).toBe('https://github.com/civicognita/civi-web.agi.git');
        expect(
            childAgiCloneUrl({
                ownerSlug: 'civicognita',
                slug: 'civi-web',
                repoName: 'wondermill',
            }),
        ).toBe('https://github.com/civicognita/civi-web.agi.git');
    });

    it('yields a URL with no spaces even when slugs are clean (regression: display name had spaces)', () => {
        const url = childAgiCloneUrl({ ownerSlug: 'civicognita', slug: 'civi-web' });
        expect(url).not.toContain(' ');
        expect(url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.agi\.git$/);
    });

    it('returns null without a usable owner OR a primary repo (cannot guess a URL)', () => {
        expect(childAgiCloneUrl({ ownerSlug: null, slug: 'civi-web' })).toBeNull();
        expect(childAgiCloneUrl({ ownerSlug: undefined, slug: 'civi-web' })).toBeNull();
        expect(childAgiCloneUrl({ ownerSlug: '', slug: 'civi-web' })).toBeNull();
        expect(childAgiCloneUrl({ ownerSlug: '   ', slug: 'civi-web' })).toBeNull();
    });

    it('returns null without a slug and without a primary repo', () => {
        expect(childAgiCloneUrl({ ownerSlug: 'civicognita', slug: '' })).toBeNull();
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
                    remote: null,
                    sourceRepoUrl: null,
                    workspacePath: '/ws/present-one.agi',
                },
                {
                    projectId: 'p2',
                    name: 'Missing Two',
                    slug: 'missing-two',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/missing-two.agi.git',
                    remote: 'exists',
                    sourceRepoUrl: null,
                },
                {
                    projectId: 'p3',
                    name: 'Missing No URL',
                    slug: 'missing-no-url',
                    status: 'missing',
                    cloneUrl: null,
                    remote: null,
                    sourceRepoUrl: null,
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

    it("EXCLUDES a probed 'not-found' envelope (genie#6: a URL that 404s must not be treated as clonable)", () => {
        const targets = provisionTargets(
            plan([
                {
                    projectId: 'p1',
                    name: 'Never Published',
                    slug: 'never-published',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/never-published.agi.git',
                    remote: 'not-found',
                    sourceRepoUrl: 'https://github.com/o/never-published.git',
                },
                {
                    projectId: 'p2',
                    name: 'Auth Walled',
                    slug: 'auth-walled',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/auth-walled.agi.git',
                    remote: 'auth-required',
                    sourceRepoUrl: null,
                },
            ]),
        );
        expect(targets).toEqual([]);
    });

    it("still ATTEMPTS an 'unknown' probe result (a flaky network must not block provisioning)", () => {
        const targets = provisionTargets(
            plan([
                {
                    projectId: 'p1',
                    name: 'Flaky',
                    slug: 'flaky',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/flaky.agi.git',
                    remote: 'unknown',
                    sourceRepoUrl: null,
                },
            ]),
        );
        expect(targets.map((t) => t.projectId)).toEqual(['p1']);
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
                    remote: null,
                    sourceRepoUrl: null,
                },
            ]),
        );
        expect(targets).toEqual([]);
    });
});

describe('scaffoldTargets', () => {
    const plan = (children: OpsProvisionPlan['children']): OpsProvisionPlan => ({
        isOps: true,
        signedIn: true,
        children,
        parentPath: '/parent',
        autoProvision: false,
    });

    it("selects missing children whose envelope is 'not-found' AND that have a source repo", () => {
        const targets = scaffoldTargets(
            plan([
                {
                    projectId: 'p1',
                    name: 'Particle Academy Web',
                    slug: 'particle-academy-web',
                    status: 'missing',
                    cloneUrl: 'https://github.com/particle-academy/particle-academy-web.agi.git',
                    remote: 'not-found',
                    sourceRepoUrl: 'https://github.com/Particle-Academy/website.git',
                },
                // Envelope exists → provision, not scaffold.
                {
                    projectId: 'p2',
                    name: 'Has Envelope',
                    slug: 'has-envelope',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/has-envelope.agi.git',
                    remote: 'exists',
                    sourceRepoUrl: 'https://github.com/o/has-envelope.git',
                },
                // No source repo → nothing to build the envelope around.
                {
                    projectId: 'p3',
                    name: 'No Source',
                    slug: 'no-source',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/no-source.agi.git',
                    remote: 'not-found',
                    sourceRepoUrl: null,
                },
            ]),
        );
        expect(targets).toEqual([
            {
                projectId: 'p1',
                name: 'Particle Academy Web',
                slug: 'particle-academy-web',
                envelopeUrl:
                    'https://github.com/particle-academy/particle-academy-web.agi.git',
                sourceRepoUrl: 'https://github.com/Particle-Academy/website.git',
            },
        ]);
    });
});

describe('classifyGitRemoteError + describeCloneFailure', () => {
    it("classifies git's repository-not-found errors", () => {
        expect(
            classifyGitRemoteError(
                "fatal: repository 'https://github.com/o/x.agi.git/' not found",
            ),
        ).toBe('not-found');
        expect(classifyGitRemoteError('remote: Repository not found.')).toBe('not-found');
    });

    it('classifies auth failures distinctly', () => {
        expect(
            classifyGitRemoteError(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            ),
        ).toBe('auth-required');
        expect(classifyGitRemoteError('fatal: Authentication failed for …')).toBe(
            'auth-required',
        );
        expect(classifyGitRemoteError('git@github.com: Permission denied (publickey).')).toBe(
            'auth-required',
        );
    });

    it('falls back to unknown for anything else', () => {
        expect(classifyGitRemoteError('ssh: connect to host github.com port 22: timed out')).toBe(
            'unknown',
        );
    });

    it('turns a not-found clone failure into a scaffold pointer (genie#6 improvement 3)', () => {
        const msg = describeCloneFailure(
            new Error("fatal: repository 'https://github.com/o/x.agi.git/' not found"),
            'https://github.com/o/x.agi.git',
        );
        expect(msg).toContain('not found');
        expect(msg).toContain('scaffold');
    });

    it('turns an auth failure into credential guidance', () => {
        const msg = describeCloneFailure(
            new Error('fatal: Authentication failed for https://github.com/o/x.agi.git'),
            'https://github.com/o/x.agi.git',
        );
        expect(msg).toContain('authentication failed');
        expect(msg).toContain('credentials');
    });
});

describe('parseEnvelopeUrl', () => {
    it('parses owner + name from https and ssh forms', () => {
        expect(parseEnvelopeUrl('https://github.com/o/x.agi.git')).toEqual({
            owner: 'o',
            name: 'x.agi',
        });
        expect(parseEnvelopeUrl('git@github.com:Some-Org/thing.agi.git')).toEqual({
            owner: 'Some-Org',
            name: 'thing.agi',
        });
    });

    it('returns null for non-github URLs', () => {
        expect(parseEnvelopeUrl('https://example.com/o/x.git')).toBeNull();
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

        const plan = await computeOpsProvisionPlan(OPS_WS, probeExists);
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

        const plan = await computeOpsProvisionPlan(OPS_WS, probeExists);
        expect(plan.children.find((c) => c.projectId === 's1')?.status).toBe('present');
    });

    it('marks a child MISSING (with a valid owner-slug clone URL) when no workspace matches', async () => {
        slaves = [
            { id: 's2', name: 'Child Two', slug: 'child-two', owner_name: 'Civicognita Operations', owner_slug: 'civicognita' },
        ];
        workspaceRows = []; // nothing local

        const plan = await computeOpsProvisionPlan(OPS_WS, probeExists);
        const child = plan.children.find((c) => c.projectId === 's2');
        expect(child?.status).toBe('missing');
        // Built from the owner SLUG, not the display name → valid, no spaces.
        expect(child?.cloneUrl).toBe('https://github.com/civicognita/child-two.agi.git');
        expect(child?.cloneUrl).not.toContain(' ');
    });

    it('builds a MISSING child clone URL from its PRIMARY repo owner + name', async () => {
        // Reporter's case: slug ≠ repo name. The envelope lives beside the repo.
        slaves = [
            {
                id: 's4',
                name: "Wish's Wonders",
                slug: 'wishswonderscom',
                owner_name: 'Renaissance Analytics',
                owner_slug: 'renaissance-analytics',
                repo_owner: 'Renaissance-Analytics',
                repo_name: 'wondermill',
            },
        ];
        workspaceRows = [];

        const plan = await computeOpsProvisionPlan(OPS_WS, probeExists);
        const child = plan.children.find((c) => c.projectId === 's4');
        expect(child?.status).toBe('missing');
        expect(child?.cloneUrl).toBe(
            'https://github.com/Renaissance-Analytics/wondermill.agi.git',
        );
    });

    it('marks a child MISSING with a null clone URL when the owner slug is absent', async () => {
        slaves = [
            { id: 's3', name: 'Child Three', slug: 'child-three', owner_name: 'Orphan', owner_slug: null },
        ];
        workspaceRows = [];

        const plan = await computeOpsProvisionPlan(OPS_WS, probeExists);
        const child = plan.children.find((c) => c.projectId === 's3');
        expect(child?.status).toBe('missing');
        expect(child?.cloneUrl).toBeNull();
        // Nothing to probe without a URL.
        expect(child?.remote).toBeNull();
    });

    it("PROBES each missing child's clone URL and records the remote state (genie#6)", async () => {
        slaves = [
            {
                id: 's5',
                name: 'Particle Academy Web',
                slug: 'particle-academy-web',
                owner_name: 'Particle Academy',
                owner_slug: 'particle-academy',
                repo_owner: 'Particle-Academy',
                repo_name: 'website',
            },
            {
                id: 's6',
                name: 'Published Child',
                slug: 'published-child',
                owner_name: 'Org',
                owner_slug: 'org',
            },
        ];
        workspaceRows = [];

        const probed: string[] = [];
        const plan = await computeOpsProvisionPlan(OPS_WS, async (url) => {
            probed.push(url);
            return url.includes('website.agi') ? 'not-found' : 'exists';
        });

        const unpublished = plan.children.find((c) => c.projectId === 's5');
        expect(unpublished?.remote).toBe('not-found');
        expect(unpublished?.sourceRepoUrl).toBe(
            'https://github.com/Particle-Academy/website.git',
        );
        const published = plan.children.find((c) => c.projectId === 's6');
        expect(published?.remote).toBe('exists');
        // Exactly the two missing URLs were probed — present children never are.
        expect(probed).toHaveLength(2);
    });

    it('a probe that THROWS degrades to unknown (still provisionable, never a crash)', async () => {
        slaves = [
            { id: 's7', name: 'Flaky', slug: 'flaky', owner_name: 'Org', owner_slug: 'org' },
        ];
        workspaceRows = [];

        const plan = await computeOpsProvisionPlan(OPS_WS, async () => {
            throw new Error('network exploded');
        });
        expect(plan.children[0]?.remote).toBe('unknown');
    });
});
