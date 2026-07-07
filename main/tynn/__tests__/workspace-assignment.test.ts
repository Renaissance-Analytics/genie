import { describe, expect, it, vi } from 'vitest';
import {
    createWorkspaceAssignmentSubscriber,
    provisionAssignedWorkspace,
    reconcileAssignedWorkspaces,
    resolveAssignmentCloneUrl,
    WorkspaceAssignmentSubscriber,
    type AssignmentProvisionDeps,
    type AssignmentTransport,
    type WorkspaceAssignment,
} from '../workspace-assignment';

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

/** Provision deps with everything faked — no disk / db / broadcast. */
function fakeDeps(over: Partial<AssignmentProvisionDeps> = {}) {
    const clone = vi.fn(async (o: { url: string; parent_path: string; folder: string }) => ({
        path: `${o.parent_path}/${o.folder}`,
    }));
    const register = vi.fn();
    const notifyChanged = vi.fn();
    const existing: Array<{ id: string }> = [];
    const deps: AssignmentProvisionDeps = {
        parentPath: '/hosts/root',
        clone,
        listExisting: () => existing,
        register,
        notifyChanged,
        envFile: '.env',
        ...over,
    };
    return { deps, clone, register, notifyChanged, existing };
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
    it('clones, registers, and broadcasts a new workspace', async () => {
        const { deps, clone, register, notifyChanged } = fakeDeps();

        const r = await provisionAssignedWorkspace(assignment(), deps);

        expect(r.status).toBe('provisioned');
        expect(r.path).toBe('/hosts/root/wonder');
        expect(clone).toHaveBeenCalledWith({
            url: 'https://github.com/acme/wonder.agi.git',
            parent_path: '/hosts/root',
            folder: 'wonder',
        });
        // Registered under the project id, as an agi/tynn workspace.
        expect(register).toHaveBeenCalledTimes(1);
        expect(register.mock.calls[0][0]).toMatchObject({
            id: 'p1',
            backend: 'tynn',
            tynn_project_id: 'p1',
            shape: 'agi',
            path: '/hosts/root/wonder',
            created_by_genie: 1,
        });
        expect(notifyChanged).toHaveBeenCalledTimes(1);
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
});

describe('reconcileAssignedWorkspaces', () => {
    it('provisions the missing, skips the present, collects errors', async () => {
        const { deps, existing } = fakeDeps();
        existing.push({ id: 'have' });

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
    });
});

/** A fake transport that captures the handlers so a test can drive connect/push. */
function fakeTransport() {
    let handlers: { onConnected: () => void; onAssignment: (a: WorkspaceAssignment) => void } | null = null;
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
        get opened() {
            return handlers !== null;
        },
    };
}

describe('WorkspaceAssignmentSubscriber', () => {
    it('reconciles on connect and provisions on push — one persistent connection, no timers', async () => {
        vi.useFakeTimers();
        const setInterval = vi.spyOn(globalThis, 'setInterval');
        const t = fakeTransport();
        const reconcile = vi.fn(async () => {});
        const provision = vi.fn(async (_a: WorkspaceAssignment) => {});

        const sub = new WorkspaceAssignmentSubscriber({ transport: t.transport, reconcile, provision });
        sub.start();
        expect(t.opened).toBe(true);

        // Each (re)connect drives ONE reconcile.
        t.connect();
        t.connect();
        await vi.runAllTimersAsync();
        expect(reconcile).toHaveBeenCalledTimes(2);

        // Each push provisions that one workspace.
        t.push(assignment({ workspaceId: 'x' }));
        await vi.runAllTimersAsync();
        expect(provision).toHaveBeenCalledTimes(1);
        expect(provision.mock.calls[0][0].workspaceId).toBe('x');

        // NEVER a polling loop.
        expect(setInterval).not.toHaveBeenCalled();

        sub.stop();
        expect(t.close).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('start is idempotent — one connection even if called twice', () => {
        const t = fakeTransport();
        const openSpy = vi.spyOn(t.transport, 'open');
        const sub = new WorkspaceAssignmentSubscriber({
            transport: t.transport,
            reconcile: vi.fn(async () => {}),
            provision: vi.fn(async () => {}),
        });
        sub.start();
        sub.start();
        expect(openSpy).toHaveBeenCalledTimes(1);
    });

    it('an error in reconcile/provision is surfaced but never tears down the sub', async () => {
        const t = fakeTransport();
        const onError = vi.fn();
        const sub = new WorkspaceAssignmentSubscriber({
            transport: t.transport,
            reconcile: vi.fn(async () => {
                throw new Error('reconcile boom');
            }),
            provision: vi.fn(async () => {}),
            onError,
        });
        sub.start();
        t.connect();
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledWith('reconcile', expect.any(Error));
    });
});

describe('createWorkspaceAssignmentSubscriber', () => {
    it('wires reconcile to fetch-then-provision the diff, and push to a single provision', async () => {
        const { deps, clone, register, existing } = fakeDeps();
        existing.push({ id: 'have' });
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
            },
        });
        sub.start();

        t.connect();
        await vi.waitFor(() => expect(fetchAssigned).toHaveBeenCalled());
        await vi.waitFor(() => expect(clone).toHaveBeenCalledTimes(1)); // only 'new1'
        expect(clone.mock.calls[0][0].folder).toBe('new1');

        t.push(assignment({ workspaceId: 'pushed', projectId: 'pushed', slug: 'pushed' }));
        await vi.waitFor(() => expect(clone).toHaveBeenCalledTimes(2));
        expect(clone.mock.calls[1][0].folder).toBe('pushed');
    });
});
