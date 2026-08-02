import { describe, expect, it, vi } from 'vitest';
import {
    createWorkspaceAssignmentSubscriber,
    deprovisionAssignedWorkspace,
    hostGenieMcpProvisioner,
    hostTynnMcpProvisioner,
    provisionAssignedWorkspace,
    reconcileAssignedWorkspaces,
    resolveAssignmentCloneUrl,
    WorkspaceAssignmentSubscriber,
    type AssignmentDeprovisionDeps,
    type AssignmentProvisionDeps,
    type AssignmentTransport,
    type IssueWatchDeltaPush,
    type WorkspaceAssignment,
} from '../workspace-assignment';
import { type TynnProvisionAuth } from '../provision';

function assignment(over: Partial<WorkspaceAssignment> = {}): WorkspaceAssignment {
    return {
        workstationId: 'ws1',
        workspaceId: 'p1',
        projectId: 'p1',
        name: 'Wonder',
        slug: 'wonder',
        cloneUrl: 'https://github.com/acme/wonder.agi.git',
        ...over,
    };
}

type Deps = AssignmentProvisionDeps & AssignmentDeprovisionDeps;

/**
 * Provision + deprovision deps with everything faked — no disk / db / broadcast /
 * terminal teardown. `existing` = all local rows (provision idempotency +
 * hasWorkspace); `managed` = the assignment-managed subset (deprovision safety).
 * `remove` keeps both consistent so convergent reconcile is exercised for real.
 */
function fakeDeps(over: Partial<Deps> = {}) {
    const clone = vi.fn(async (o: { url: string; parent_path: string; folder: string }) => ({
        path: `${o.parent_path}/${o.folder}`,
    }));
    const register = vi.fn();
    const notifyChanged = vi.fn();
    const stopTerminals = vi.fn((id: string) => [`${id}-t1`]);
    const existing: Array<{ id: string; path?: string }> = [];
    const managed: Array<{ id: string }> = [];
    const remove = vi.fn((id: string) => {
        const i = existing.findIndex((w) => w.id === id);
        if (i >= 0) existing.splice(i, 1);
        const j = managed.findIndex((w) => w.id === id);
        if (j >= 0) managed.splice(j, 1);
    });
    const deps: Deps = {
        parentPath: '/hosts/root',
        clone,
        register,
        listExisting: () => existing,
        notifyChanged,
        envFile: '.env',
        listManaged: () => managed,
        hasWorkspace: (id) => existing.some((w) => w.id === id),
        stopTerminals,
        remove,
        ...over,
    };
    return { deps, clone, register, notifyChanged, stopTerminals, remove, existing, managed };
}

describe('resolveAssignmentCloneUrl', () => {
    it('prefers the URL Tynn sent', () => {
        expect(resolveAssignmentCloneUrl(assignment({ cloneUrl: 'https://x/y.agi.git' }))).toBe(
            'https://x/y.agi.git',
        );
    });

    it('re-derives from the primary repo owner/name when no URL', () => {
        const a = assignment({ cloneUrl: null, repoOwner: 'Renaissance-Analytics', repoName: 'wondermill' });
        expect(resolveAssignmentCloneUrl(a)).toBe(
            'https://github.com/Renaissance-Analytics/wondermill.agi.git',
        );
    });

    it('falls back to owner-slug + slug when no repo', () => {
        const a = assignment({ cloneUrl: null, ownerSlug: 'acme-co', slug: 'wonder' });
        expect(resolveAssignmentCloneUrl(a)).toBe('https://github.com/acme-co/wonder.agi.git');
    });

    it('is null when nothing can form a URL', () => {
        const a = assignment({ cloneUrl: null, ownerSlug: null, repoOwner: null, repoName: null, slug: 'wonder' });
        expect(resolveAssignmentCloneUrl(a)).toBeNull();
    });
});

describe('provisionAssignedWorkspace', () => {
    it('clones, registers (assignment_managed), and broadcasts a new workspace', async () => {
        const { deps, clone, register, notifyChanged } = fakeDeps();

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(r.path).toBe('/hosts/root/wonder');
        expect(clone).toHaveBeenCalledWith({
            url: 'https://github.com/acme/wonder.agi.git',
            parent_path: '/hosts/root',
            folder: 'wonder',
        });
        // Registered under the project id, as an agi/tynn assignment-managed row.
        expect(register).toHaveBeenCalledTimes(1);
        expect(register.mock.calls[0][0]).toMatchObject({
            id: 'p1',
            backend: 'tynn',
            tynn_project_id: 'p1',
            shape: 'agi',
            path: '/hosts/root/wonder',
            created_by_genie: 1,
            assignment_managed: 1,
        });
        expect(notifyChanged).toHaveBeenCalledTimes(1);
    });

    it('threads a getCloneToken credential into the clone (genie #47 headless host)', async () => {
        const getCloneToken = vi.fn(async () => 'ghs_installtoken');
        const { deps, clone } = fakeDeps({ getCloneToken });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(getCloneToken).toHaveBeenCalledWith('https://github.com/acme/wonder.agi.git');
        expect(clone).toHaveBeenCalledWith({
            url: 'https://github.com/acme/wonder.agi.git',
            parent_path: '/hosts/root',
            folder: 'wonder',
            token: 'ghs_installtoken',
        });
    });

    it('a getCloneToken failure falls back to ambient auth (null token), never aborts', async () => {
        const getCloneToken = vi.fn(async () => {
            throw new Error('git-credential endpoint down');
        });
        const { deps, clone } = fakeDeps({ getCloneToken });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(clone).toHaveBeenCalledWith({
            url: 'https://github.com/acme/wonder.agi.git',
            parent_path: '/hosts/root',
            folder: 'wonder',
            token: null,
        });
    });

    it('reports each provisioning stage via reportProgress in order (genie #45)', async () => {
        const reportProgress = vi.fn();
        const { deps } = fakeDeps({ reportProgress });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(reportProgress.mock.calls.map(([i]) => `${i.step}:${i.status}`)).toEqual([
            'cloning:running',
            'cloning:done',
            'submodules:done',
            'agent_config:running',
            'agent_config:done',
            'ready:done',
        ]);
        expect(reportProgress.mock.calls.every(([i]) => i.workspaceId === 'p1')).toBe(true);
    });

    // genie#128 — the ticks are fire-and-forget concurrent POSTs that can RACE
    // (an `error` can arrive before the `running` that preceded it, leaving the UI
    // stuck on the stale `running`). A monotonic seq stamped at emission lets the
    // consumer keep the latest-emitted tick regardless of delivery order.
    it('stamps each progress tick with a strictly increasing, unique seq (genie#128 out-of-order guard)', async () => {
        const reportProgress = vi.fn();
        const { deps } = fakeDeps({ reportProgress });

        await provisionAssignedWorkspace(assignment(), deps);

        const seqs = reportProgress.mock.calls.map(([i]) => i.seq);
        expect(seqs.length).toBeGreaterThan(1);
        expect(seqs.every((s) => typeof s === 'number')).toBe(true);
        // Monotonic increasing (emission order) and unique.
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(seqs.length);
    });

    it('reports an error on the current stage when the clone fails', async () => {
        const reportProgress = vi.fn();
        const { deps } = fakeDeps({
            reportProgress,
            clone: vi.fn(async () => {
                throw new Error('repository not found');
            }),
        });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('error');
        expect(reportProgress.mock.calls.map(([i]) => `${i.step}:${i.status}`)).toEqual([
            'cloning:running',
            'cloning:error',
        ]);
        expect(reportProgress.mock.calls.at(-1)?.[0].message).toMatch(/repository not found/);
    });

    it('a throwing reportProgress never breaks provisioning (best-effort)', async () => {
        const reportProgress = vi.fn(() => {
            throw new Error('reporter down');
        });
        const { deps } = fakeDeps({ reportProgress });

        const r = await provisionAssignedWorkspace(assignment(), deps);
        expect(r.status).toBe('provisioned');
    });

    it('is idempotent — a workspace already registered is a no-op', async () => {
        const { deps, clone, register, notifyChanged, existing } = fakeDeps();
        existing.push({ id: 'p1' });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('exists');
        expect(clone).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
        expect(notifyChanged).not.toHaveBeenCalled();
    });

    // genie#47 — self-healing recovery when a clone already exists ON DISK but has
    // no DB row (partial provision / DB reset / crash between clone and register).
    // Before the fix this hard-failed forever on cloneAgiEnvelope's "Target folder
    // is not empty" guard, bricking the assignment.
    it('ADOPTS an existing complete on-disk clone when there is no DB row (idempotent recovery)', async () => {
        const { deps, clone, register, notifyChanged } = fakeDeps({
            // The default dest for slug "wonder" is `<parent>/wonder.agi`; inject a
            // deterministic (forward-slash) dest so the assertion is OS-independent.
            resolveDest: (p, slug) => `${p}/${slug}.agi`,
            inspectTarget: () => 'valid',
        });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(r.path).toBe('/hosts/root/wonder.agi');
        // Never re-clone over a complete clone — adopt it.
        expect(clone).not.toHaveBeenCalled();
        expect(register).toHaveBeenCalledTimes(1);
        expect(register.mock.calls[0][0]).toMatchObject({
            id: 'p1',
            path: '/hosts/root/wonder.agi',
            assignment_managed: 1,
        });
        expect(notifyChanged).toHaveBeenCalledTimes(1);
    });

    it('reports the same stage sequence when adopting an existing clone', async () => {
        const reportProgress = vi.fn();
        const { deps } = fakeDeps({ inspectTarget: () => 'valid', reportProgress });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(reportProgress.mock.calls.map(([i]) => `${i.step}:${i.status}`)).toEqual([
            'cloning:running',
            'cloning:done',
            'submodules:done',
            'agent_config:running',
            'agent_config:done',
            'ready:done',
        ]);
    });

    it('CLEANS a stale/partial folder then re-clones (no DB row, incomplete clone)', async () => {
        const cleanTarget = vi.fn();
        const { deps, clone, register } = fakeDeps({
            resolveDest: (p, slug) => `${p}/${slug}.agi`,
            inspectTarget: () => 'stale',
            cleanTarget,
        });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(cleanTarget).toHaveBeenCalledWith('/hosts/root/wonder.agi');
        expect(clone).toHaveBeenCalledWith({
            url: 'https://github.com/acme/wonder.agi.git',
            parent_path: '/hosts/root',
            folder: 'wonder',
        });
        expect(register).toHaveBeenCalledTimes(1);
    });

    it('errors (never throws) when no clone URL can be resolved', async () => {
        const { deps, clone } = fakeDeps();
        const r = await provisionAssignedWorkspace(
            assignment({ cloneUrl: null, ownerSlug: null, repoOwner: null, repoName: null }),
            deps,
        );
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/no .agi clone URL/);
        expect(clone).not.toHaveBeenCalled();
    });

    // genie-cloud#13 — an error the host only RETURNS is an error Tynn never hears.
    // Tynn #114 persists a terminal tick onto the workspace instance, so an `error`
    // becomes a stored failure the owner can read; a workspace whose provisioning
    // fails WITHOUT a tick just sits at 'unknown' forever. This early return bailed
    // out above the `report` closure, so the one failure a user can actually fix
    // (a workspace with no resolvable `.agi` URL) was the one Tynn never showed.
    it('EMITS a provision-progress error when no clone URL can be resolved (genie-cloud#13)', async () => {
        const reportProgress = vi.fn();
        const { deps } = fakeDeps({ reportProgress });

        const r = await provisionAssignedWorkspace(
            assignment({ cloneUrl: null, ownerSlug: null, repoOwner: null, repoName: null }),
            deps,
        );

        expect(r.status).toBe('error');
        expect(reportProgress.mock.calls.map(([i]) => `${i.step}:${i.status}`)).toEqual([
            'cloning:error',
        ]);
        const tick = reportProgress.mock.calls.at(-1)?.[0];
        expect(tick.workspaceId).toBe('p1');
        // The reported reason must match the returned one — same failure, one story.
        expect(tick.message).toBe(r.error);
        expect(tick.message).toMatch(/no .agi clone URL/);
        expect(typeof tick.seq).toBe('number');
    });

    // genie-cloud#13 — the 'exists' short-circuit reported nothing at all, and per
    // Tynn's recordProvisionResult ONLY a `ready`+`done` clears a stored error. So a
    // workspace that failed once and is present on the next reconcile (adopted, or
    // provisioned by an earlier host) stayed ERROR in Tynn permanently — a failure
    // that had already healed and could never be un-said.
    it('EMITS ready:done for an already-registered workspace so a stored error can clear (genie-cloud#13)', async () => {
        const reportProgress = vi.fn();
        const { deps, existing, clone } = fakeDeps({ reportProgress });
        existing.push({ id: 'p1' });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('exists');
        expect(clone).not.toHaveBeenCalled();
        expect(reportProgress.mock.calls.map(([i]) => `${i.step}:${i.status}`)).toEqual([
            'ready:done',
        ]);
        expect(reportProgress.mock.calls[0][0]).toMatchObject({ workspaceId: 'p1' });
    });

    it('captures a clone failure as an error result (best-effort)', async () => {
        const { deps, register, notifyChanged } = fakeDeps({
            clone: vi.fn(async () => {
                throw new Error('repository not found');
            }),
        });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('error');
        expect(r.error).toMatch(/repository not found/);
        expect(register).not.toHaveBeenCalled();
        expect(notifyChanged).not.toHaveBeenCalled();
    });

    // genie #52 — after clone + register, provision the on-host Tynn MCP so a
    // headless host's agents can reach Tynn with the host's own identity.
    it('provisions the on-host Tynn MCP after registering the workspace (genie #52)', async () => {
        const provisionTynnMcp = vi.fn(async () => {});
        const { deps, register, notifyChanged } = fakeDeps({ provisionTynnMcp });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(register).toHaveBeenCalledTimes(1);
        // Passed the on-disk path + the workspace's Tynn project id.
        expect(provisionTynnMcp).toHaveBeenCalledWith({
            workspacePath: '/hosts/root/wonder',
            projectId: 'p1',
        });
        expect(notifyChanged).toHaveBeenCalledTimes(1);
    });

    it('a failing Tynn MCP provision NEVER breaks workspace provisioning (best-effort)', async () => {
        const provisionTynnMcp = vi.fn(async () => {
            throw new Error('mint endpoint down');
        });
        const { deps, register, notifyChanged } = fakeDeps({ provisionTynnMcp });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(register).toHaveBeenCalledTimes(1);
        expect(provisionTynnMcp).toHaveBeenCalled();
        expect(notifyChanged).toHaveBeenCalledTimes(1);
    });

    it('skips Tynn MCP provisioning when the seam is absent (desktop path)', async () => {
        const { deps } = fakeDeps(); // no provisionTynnMcp injected
        const r = await provisionAssignedWorkspace(assignment(), deps);
        expect(r.status).toBe('provisioned');
    });

    // genie #55 — after register, ALSO provision the on-host GENIE MCP so a member's
    // agents get the full Genie tool surface (imDone / ForceTheQuestion / …), not
    // just Tynn. Keyed by the WORKSPACE id (the loopback endpoint is per-workspace),
    // not the project id.
    it('provisions the on-host genie MCP after registering the workspace (genie #55)', async () => {
        const provisionGenieMcp = vi.fn();
        const { deps, register, notifyChanged } = fakeDeps({ provisionGenieMcp });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(register).toHaveBeenCalledTimes(1);
        expect(provisionGenieMcp).toHaveBeenCalledWith({
            workspacePath: '/hosts/root/wonder',
            workspaceId: 'p1',
        });
        expect(notifyChanged).toHaveBeenCalledTimes(1);
    });

    it('a failing genie MCP provision NEVER breaks workspace provisioning (best-effort)', async () => {
        const provisionGenieMcp = vi.fn(() => {
            throw new Error('mcp server not listening yet');
        });
        const { deps, register, notifyChanged } = fakeDeps({ provisionGenieMcp });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(register).toHaveBeenCalledTimes(1);
        expect(provisionGenieMcp).toHaveBeenCalled();
        expect(notifyChanged).toHaveBeenCalledTimes(1);
    });

    it('skips genie MCP provisioning when the seam is absent (desktop path)', async () => {
        const { deps } = fakeDeps(); // no provisionGenieMcp injected
        const r = await provisionAssignedWorkspace(assignment(), deps);
        expect(r.status).toBe('provisioned');
    });

    // genie #55 upgrade gap — a workspace ALREADY cloned by an older host (before
    // #55) short-circuited at the 'exists' guard and never got the genie MCP entry.
    // Ensure the on-host MCP config is (re)written idempotently for existing
    // workspaces too, so `.mcp.json` gains the genie server after an image upgrade —
    // without re-cloning.
    it('ensures BOTH on-host MCP entries for an ALREADY-existing workspace, without re-cloning (#55 upgrade gap)', async () => {
        const provisionTynnMcp = vi.fn(async () => {});
        const provisionGenieMcp = vi.fn();
        const { deps, clone, existing } = fakeDeps({ provisionTynnMcp, provisionGenieMcp });
        // The workspace was cloned by an OLDER host — already registered on disk.
        existing.push({ id: 'p1', path: '/hosts/root/wonder' });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('exists');
        expect(clone).not.toHaveBeenCalled(); // NEVER re-clones an existing workspace
        // ...but it DOES converge the MCP config, so the genie entry lands post-upgrade.
        expect(provisionTynnMcp).toHaveBeenCalledWith({
            workspacePath: '/hosts/root/wonder',
            projectId: 'p1',
        });
        expect(provisionGenieMcp).toHaveBeenCalledWith({
            workspacePath: '/hosts/root/wonder',
            workspaceId: 'p1',
        });
    });

    it('a failing MCP ensure on an existing workspace still returns exists (best-effort)', async () => {
        const provisionGenieMcp = vi.fn(() => {
            throw new Error('mcp server not listening yet');
        });
        const { deps, existing } = fakeDeps({ provisionGenieMcp });
        existing.push({ id: 'p1', path: '/hosts/root/wonder' });

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('exists');
        expect(provisionGenieMcp).toHaveBeenCalled();
    });
});

describe('hostTynnMcpProvisioner (genie #52 mint-auth glue)', () => {
    it('drives provisionWorkspaceTynn with the injected host mint as the auth source (never the cookie)', async () => {
        const hostMint = vi.fn(async (projectId: string) => ({
            token: `rpk_host.${projectId}`,
            mcpUrl: 'https://tynn.ai/mcp/tynn',
            agent: { id: 'a', name: 'Genie' },
            isOpsProject: false,
        }));
        const provision = vi.fn(
            async (
                _workspacePath: string,
                _opts?: { force?: boolean; auth?: TynnProvisionAuth },
            ) => ({ status: 'provision' as const }),
        );

        const fn = hostTynnMcpProvisioner(hostMint, provision);
        await fn({ workspacePath: '/hosts/root/wonder', projectId: 'p1' });

        expect(provision).toHaveBeenCalledTimes(1);
        const [wsPath, opts] = provision.mock.calls[0];
        expect(wsPath).toBe('/hosts/root/wonder');
        expect(opts?.force).toBe(true);
        // The injected AUTH SOURCE is host-signed: ready() is unconditional and
        // mint() delegates to the Workstation-authed minter — the cookie whoami is
        // never consulted.
        expect(await opts?.auth?.ready()).toBe(true);
        await opts?.auth?.mint('p1');
        expect(hostMint).toHaveBeenCalledWith('p1');
    });
});

describe('hostGenieMcpProvisioner (genie #55 loopback glue)', () => {
    it('writes the workspace .mcp.json genie entry at the host loopback endpoint for that workspace', () => {
        const writeMcp = vi.fn();
        const endpointUrl = vi.fn(() => 'http://127.0.0.1:5199/mcp/tok-p1');

        const fn = hostGenieMcpProvisioner(writeMcp, endpointUrl);
        fn({ workspacePath: '/hosts/root/wonder', workspaceId: 'p1' });

        // The endpoint is minted for THIS workspace id...
        expect(endpointUrl).toHaveBeenCalledWith('p1');
        // ...and written as an ENABLED genie entry pointing at the host's own server.
        expect(writeMcp).toHaveBeenCalledWith(
            '/hosts/root/wonder',
            true,
            'http://127.0.0.1:5199/mcp/tok-p1',
        );
    });

    it('passes a null url through so the writer REMOVES a stale entry when the server is not listening yet', () => {
        const writeMcp = vi.fn();
        const endpointUrl = vi.fn(() => null);

        const fn = hostGenieMcpProvisioner(writeMcp, endpointUrl);
        fn({ workspacePath: '/hosts/root/wonder', workspaceId: 'p1' });

        // null URL ⇒ writeWorkspaceAgentMcp deletes any prior entry; the next
        // reconcile (once the port is bound) self-corrects.
        expect(writeMcp).toHaveBeenCalledWith('/hosts/root/wonder', true, null);
    });
});

describe('deprovisionAssignedWorkspace', () => {
    it('stops terminals, unregisters, and broadcasts an assignment-managed workspace', async () => {
        const { deps, stopTerminals, remove, notifyChanged, existing, managed } = fakeDeps();
        existing.push({ id: 'p1' });
        managed.push({ id: 'p1' });

        const r = await deprovisionAssignedWorkspace('p1', deps);

        expect(r.status).toBe('deprovisioned');
        expect(r.stopped).toEqual(['p1-t1']);
        expect(stopTerminals).toHaveBeenCalledWith('p1');
        expect(remove).toHaveBeenCalledWith('p1');
        expect(notifyChanged).toHaveBeenCalledTimes(1);
    });

    it('REFUSES a present-but-unmanaged workspace (never touches ops/user rows)', async () => {
        const { deps, stopTerminals, remove, notifyChanged, existing } = fakeDeps();
        existing.push({ id: 'ops1' }); // exists but NOT in managed

        const r = await deprovisionAssignedWorkspace('ops1', deps);

        expect(r.status).toBe('skipped');
        expect(stopTerminals).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(notifyChanged).not.toHaveBeenCalled();
    });

    it('is an idempotent no-op (absent) when there is no such workspace', async () => {
        const { deps, remove } = fakeDeps();
        const r = await deprovisionAssignedWorkspace('ghost', deps);
        expect(r.status).toBe('absent');
        expect(remove).not.toHaveBeenCalled();
    });

    it('treats an empty id as absent', async () => {
        const { deps, remove } = fakeDeps();
        expect((await deprovisionAssignedWorkspace('', deps)).status).toBe('absent');
        expect(remove).not.toHaveBeenCalled();
    });
});

describe('reconcileAssignedWorkspaces', () => {
    it('provisions the missing, skips the present, collects errors', async () => {
        const { deps, existing, managed } = fakeDeps();
        existing.push({ id: 'have' });
        managed.push({ id: 'have' }); // already assigned + local → left alone

        const res = await reconcileAssignedWorkspaces(
            [
                assignment({ workspaceId: 'have', projectId: 'have', name: 'Have' }),
                assignment({ workspaceId: 'new1', projectId: 'new1', name: 'New1', slug: 'new1' }),
                assignment({ workspaceId: 'bad', projectId: 'bad', name: 'Bad', cloneUrl: null, ownerSlug: null, repoOwner: null, repoName: null }),
            ],
            deps,
        );

        expect(res.provisioned).toEqual(['new1']);
        expect(res.existing).toEqual(['have']);
        expect(res.errors).toHaveLength(1);
        expect(res.errors[0]).toMatch(/^Bad: /);
        expect(res.deprovisioned).toEqual([]);
    });

    // genie-cloud#13 — `errors` is a local rollup that only ever reached a console
    // line. Whatever the reconcile concludes about a workspace has to reach TYNN,
    // per workspace: the one that failed gets an error tick carrying the reason, and
    // the ones that are fine get a terminal ready:done that clears any stored error.
    it('EMITS a per-workspace tick to Tynn for every outcome, not just the console rollup', async () => {
        const reportProgress = vi.fn();
        const { deps, existing, managed } = fakeDeps({ reportProgress });
        existing.push({ id: 'have' });
        managed.push({ id: 'have' });

        const res = await reconcileAssignedWorkspaces(
            [
                assignment({ workspaceId: 'have', projectId: 'have', name: 'Have' }),
                assignment({ workspaceId: 'new1', projectId: 'new1', name: 'New1', slug: 'new1' }),
                assignment({ workspaceId: 'bad', projectId: 'bad', name: 'Bad', cloneUrl: null, ownerSlug: null, repoOwner: null, repoName: null }),
            ],
            deps,
        );

        expect(res.errors).toHaveLength(1);

        const ticksFor = (id: string) =>
            reportProgress.mock.calls
                .map(([i]) => i)
                .filter((i) => i.workspaceId === id)
                .map((i) => `${i.step}:${i.status}`);

        // The failure Tynn must store, with the reason attached.
        expect(ticksFor('bad')).toEqual(['cloning:error']);
        expect(
            reportProgress.mock.calls.map(([i]) => i).find((i) => i.workspaceId === 'bad').message,
        ).toMatch(/no .agi clone URL/);
        // The successes Tynn must be able to clear a previous failure with.
        expect(ticksFor('new1').at(-1)).toBe('ready:done');
        expect(ticksFor('have')).toEqual(['ready:done']);
    });

    it('CONVERGES: deprovisions assignment-managed locals Tynn no longer assigns', async () => {
        const { deps, remove, stopTerminals, existing, managed } = fakeDeps();
        // Local state: 'keep' + 'drop' are assignment-managed; 'ops' is a foreign
        // (ops-provisioned) row that must never be touched.
        existing.push({ id: 'keep' }, { id: 'drop' }, { id: 'ops' });
        managed.push({ id: 'keep' }, { id: 'drop' });

        const res = await reconcileAssignedWorkspaces(
            [assignment({ workspaceId: 'keep', projectId: 'keep', slug: 'keep' })],
            deps,
        );

        expect(res.deprovisioned).toEqual(['drop']);
        expect(remove).toHaveBeenCalledWith('drop');
        expect(stopTerminals).toHaveBeenCalledWith('drop');
        expect(remove).not.toHaveBeenCalledWith('keep');
        expect(remove).not.toHaveBeenCalledWith('ops'); // safety: foreign row untouched
    });
});

/** A fake transport that captures the handlers so a test can drive connect / push. */
function fakeTransport() {
    let handlers: {
        onConnected: () => void;
        onAssignment: (a: WorkspaceAssignment) => void;
        onUnassignment?: (workspaceId: string) => void;
        onIssueWatchDelta?: (delta: IssueWatchDeltaPush) => void;
    } | null = null;
    const close = vi.fn();
    const transport: AssignmentTransport = {
        open: (h) => {
            handlers = h;
            return { close };
        },
    };
    return {
        transport,
        close,
        connect: () => handlers?.onConnected(),
        push: (a: WorkspaceAssignment) => handlers?.onAssignment(a),
        unassign: (id: string) => handlers?.onUnassignment?.(id),
        pushDelta: (d: IssueWatchDeltaPush) => handlers?.onIssueWatchDelta?.(d),
        get opened() {
            return handlers !== null;
        },
    };
}

describe('WorkspaceAssignmentSubscriber', () => {
    it('reconciles on connect, provisions on push, deprovisions on unassign — no timers', async () => {
        vi.useFakeTimers();
        // Count setInterval calls WITHOUT vi.spyOn. Fake timers already own this
        // global slot, and a spy taken on top of it records the fake clock's
        // shim as the value to put back — which vitest then does at end of file,
        // long after the clock is uninstalled. That left every later test file
        // in the fork (they all share one) with a setInterval wired to a clock
        // nobody advances, so it never fired: the MCP server's SSE heartbeat
        // stopped beating and genie#76 looked like a CI load flake. A plain
        // vi.fn() belongs to no slot, so nothing can reinstate it behind us.
        const clockSetInterval = globalThis.setInterval;
        const setInterval = vi.fn(clockSetInterval);
        globalThis.setInterval = setInterval as unknown as typeof globalThis.setInterval;
        try {
            const t = fakeTransport();
            const reconcile = vi.fn(async () => {});
            const provision = vi.fn(async (_a: WorkspaceAssignment) => {});
            const deprovision = vi.fn(async (_id: string) => {});

            const sub = new WorkspaceAssignmentSubscriber({ transport: t.transport, reconcile, provision, deprovision });
            sub.start();
            expect(t.opened).toBe(true);

            // Each (re)connect drives ONE reconcile.
            t.connect();
            t.connect();
            await vi.runAllTimersAsync();
            expect(reconcile).toHaveBeenCalledTimes(2);

            // Each assignment push provisions that one workspace.
            t.push(assignment({ workspaceId: 'x' }));
            await vi.runAllTimersAsync();
            expect(provision).toHaveBeenCalledTimes(1);
            expect(provision.mock.calls[0][0].workspaceId).toBe('x');

            // Each unassignment push deprovisions that one workspace.
            t.unassign('x');
            await vi.runAllTimersAsync();
            expect(deprovision).toHaveBeenCalledTimes(1);
            expect(deprovision.mock.calls[0][0]).toBe('x');

            // NEVER a polling loop.
            expect(setInterval).not.toHaveBeenCalled();

            sub.stop();
            expect(t.close).toHaveBeenCalledTimes(1);
        } finally {
            // Unwind in the reverse order we wrapped: put the clock's own shim
            // back, THEN uninstall the clock so the real setInterval returns.
            globalThis.setInterval = clockSetInterval;
            vi.useRealTimers();
        }
    });

    it('start is idempotent — one connection even if called twice', () => {
        const t = fakeTransport();
        const openSpy = vi.spyOn(t.transport, 'open');
        const sub = new WorkspaceAssignmentSubscriber({
            transport: t.transport,
            reconcile: vi.fn(async () => {}),
            provision: vi.fn(async () => {}),
            deprovision: vi.fn(async () => {}),
        });
        sub.start();
        sub.start();
        expect(openSpy).toHaveBeenCalledTimes(1);
    });

    it('an error in a step is surfaced but never tears down the sub', async () => {
        const t = fakeTransport();
        const onError = vi.fn();
        const sub = new WorkspaceAssignmentSubscriber({
            transport: t.transport,
            reconcile: vi.fn(async () => {
                throw new Error('reconcile boom');
            }),
            provision: vi.fn(async () => {}),
            deprovision: vi.fn(async () => {
                throw new Error('deprovision boom');
            }),
            onError,
        });
        sub.start();
        t.connect();
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledWith('reconcile', expect.any(Error));

        t.unassign('z');
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledWith('deprovision', expect.any(Error));
    });

    it('routes an issuewatch.delta to applyIssueWatchDelta, and clears it on unassign', async () => {
        const t = fakeTransport();
        const applyIssueWatchDelta = vi.fn();
        const clearIssueWatchDelta = vi.fn();
        const sub = new WorkspaceAssignmentSubscriber({
            transport: t.transport,
            reconcile: vi.fn(async () => {}),
            provision: vi.fn(async () => {}),
            deprovision: vi.fn(async () => {}),
            applyIssueWatchDelta,
            clearIssueWatchDelta,
        });
        sub.start();

        const push: IssueWatchDeltaPush = {
            workspaceId: 'p1', projectId: 'p1', counts: { issue: 2, pr: 0, security: 1 }, items: [{ key: 'o/r:issue:1' }],
        };
        t.pushDelta(push);
        expect(applyIssueWatchDelta).toHaveBeenCalledWith(push);

        // Detach drops the server-fed snapshot too.
        t.unassign('p1');
        expect(clearIssueWatchDelta).toHaveBeenCalledWith('p1');
    });
});

describe('createWorkspaceAssignmentSubscriber', () => {
    it('wires reconcile to converge, push to provision, and unassign to deprovision', async () => {
        const { deps, clone, register, remove, stopTerminals, existing, managed } = fakeDeps();
        existing.push({ id: 'have' });
        managed.push({ id: 'have' });
        const t = fakeTransport();
        const fetchAssigned = vi.fn(async () => [
            assignment({ workspaceId: 'have', projectId: 'have' }),
            assignment({ workspaceId: 'new1', projectId: 'new1', slug: 'new1' }),
        ]);

        const sub = createWorkspaceAssignmentSubscriber({
            transport: t.transport,
            fetchAssigned,
            parentPath: deps.parentPath,
            provisionDeps: {
                clone,
                register,
                listExisting: () => existing,
                notifyChanged: vi.fn(),
                envFile: '.env',
                listManaged: () => managed,
                hasWorkspace: (id) => existing.some((w) => w.id === id),
                stopTerminals,
                remove,
            },
        });
        sub.start();

        t.connect();
        await vi.waitFor(() => expect(fetchAssigned).toHaveBeenCalled());
        await vi.waitFor(() => expect(clone).toHaveBeenCalledTimes(1)); // only 'new1'
        expect(clone.mock.calls[0][0].folder).toBe('new1');

        // An unassignment push tears down that assignment-managed workspace.
        managed.push({ id: 'gone' });
        existing.push({ id: 'gone' });
        t.unassign('gone');
        await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('gone'));
        expect(stopTerminals).toHaveBeenCalledWith('gone');
    });
});
