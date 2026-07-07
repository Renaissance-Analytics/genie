import { addWorkspace, getAllSettings, listWorkspaces } from '../db';
import { cloneAgiEnvelope } from '../workspace/create-agi';
import { broadcastWorkspacesChanged } from '../ipc';
import { childAgiCloneUrl } from './ops-provision';

/**
 * Workspace-assignment PUSH provisioning (headless host side).
 *
 * An org admin assigns an envelope Workspace to this Workstation in Tynn. Tynn
 * PUSHES a `WorkspaceAssigned` event (over its private `workstation.{id}`
 * channel) — there is NO polling. On the push the host AUTO-PROVISIONS the
 * workspace: clone its `*.agi` envelope + register it, then broadcast a
 * `workspaces:changed` so remote Genie sessions live-update (the desktop rail
 * fades the new one in). A one-shot RECONCILE against the host-authed
 * `GET /api/v1/workstations/{id}/workspaces` runs on each (re)connect to catch
 * assignments made while the host was offline — again, one-shot, NOT a loop.
 *
 * Sibling of ops-provision.ts and reuses its machinery: `cloneAgiEnvelope` +
 * `addWorkspace` (the same clone+register applyOpsProvision does) and
 * `childAgiCloneUrl` (identical `*.agi` URL derivation, so the host verifies the
 * URL Tynn sent with zero drift). The assignment IS the approval — no gate here
 * (Tynn already authorized the org admin).
 *
 * TRANSPORT SEAM: the persistent subscription itself ({@link AssignmentTransport})
 * is INJECTED — the concrete carrier (a Pusher client on Tynn's private channel,
 * authorized via the host-token broadcasting-auth endpoint) is built by the
 * genie-cloud shell, which holds the host token + broadcast credentials. This
 * module owns the orchestration + provisioning; the shell owns the socket. That
 * keeps this unit-testable (a fake transport) and electron-free at the seam.
 */

/** One assignment — the shape of Tynn's `WorkspaceAssigned` payload AND of each
 *  row from the reconcile endpoint (a Workspace IS a Project, so id keys align). */
export interface WorkspaceAssignment {
    workstationId: string;
    /** The workspace's Tynn project id (== projectId). Drives the workspace row id. */
    workspaceId: string;
    projectId: string;
    name: string;
    slug: string;
    /** The `*.agi` envelope clone URL Tynn derived; null when it couldn't form one. */
    cloneUrl: string | null;
    /** Raw source fields so the host can RE-DERIVE the URL with childAgiCloneUrl. */
    ownerSlug?: string | null;
    repoOwner?: string | null;
    repoName?: string | null;
}

/**
 * The `*.agi` URL to clone: prefer the URL Tynn sent, else re-derive locally from
 * the raw fields with the SAME `childAgiCloneUrl` ops-provision uses (so a Tynn
 * that couldn't form one, or that we want to double-check, still resolves the
 * conventional URL). Null when neither can be formed — the caller reports it.
 */
export function resolveAssignmentCloneUrl(a: WorkspaceAssignment): string | null {
    const url = a.cloneUrl?.trim();
    if (url) return url;
    return childAgiCloneUrl({
        ownerSlug: a.ownerSlug,
        slug: a.slug,
        repoOwner: a.repoOwner,
        repoName: a.repoName,
    });
}

export type AssignmentProvisionStatus = 'provisioned' | 'exists' | 'error';

export interface AssignmentProvisionResult {
    status: AssignmentProvisionStatus;
    workspaceId: string;
    /** Local path, when provisioned. */
    path?: string;
    /** Failure detail, when status is 'error'. */
    error?: string;
}

/** Injectable seams — default to the real db / clone / broadcast so callers pass
 *  only `parentPath`; tests pass fakes and touch no disk / db / Electron. */
export interface AssignmentProvisionDeps {
    /** Parent folder new envelopes clone into (`<parent>/<slug>`). */
    parentPath: string;
    clone?: (opts: { url: string; parent_path: string; folder: string }) => Promise<{ path: string }>;
    listExisting?: () => Array<{ id: string }>;
    register?: (row: Parameters<typeof addWorkspace>[0]) => unknown;
    /** Announce the workspace-list change to clients (default: broadcastWorkspacesChanged). */
    notifyChanged?: () => void;
    /** env-file for the registered row (default: the global default_env_file). */
    envFile?: string;
}

/**
 * Clone + register ONE assigned workspace, then broadcast the list change.
 * IDEMPOTENT: a workspace already registered under this id (a duplicate push, or
 * one the reconcile already handled) is a no-op — never re-clone. Best-effort:
 * a clone/derive failure is RETURNED, never thrown, so one bad assignment can't
 * kill the subscription.
 */
export async function provisionAssignedWorkspace(
    a: WorkspaceAssignment,
    deps: AssignmentProvisionDeps,
): Promise<AssignmentProvisionResult> {
    const clone = deps.clone ?? cloneAgiEnvelope;
    const listExisting = deps.listExisting ?? listWorkspaces;
    const register = deps.register ?? addWorkspace;
    const notifyChanged = deps.notifyChanged ?? broadcastWorkspacesChanged;

    if (listExisting().some((w) => w.id === a.workspaceId)) {
        return { status: 'exists', workspaceId: a.workspaceId };
    }

    const url = resolveAssignmentCloneUrl(a);
    if (!url) {
        return {
            status: 'error',
            workspaceId: a.workspaceId,
            error: `no .agi clone URL could be resolved for "${a.name}"`,
        };
    }

    try {
        const { path: wsPath } = await clone({ url, parent_path: deps.parentPath, folder: a.slug });
        register({
            id: a.workspaceId,
            backend: 'tynn',
            project_id: a.workspaceId,
            project_name: a.name,
            tynn_project_id: a.workspaceId,
            tynn_project_name: a.name,
            shape: 'agi',
            path: wsPath,
            editor: null,
            editor_cmd: null,
            start_cmd: null,
            env_file: deps.envFile ?? getAllSettings().default_env_file ?? '.env',
            last_opened_at: null,
            created_by_genie: 1,
        });
        // The workspace-list broadcast assign-ui keys off — emits `workspaces:changed`
        // locally + over the host `/ws/events` so remote sessions re-fetch + fade in.
        notifyChanged();
        return { status: 'provisioned', workspaceId: a.workspaceId, path: wsPath };
    } catch (e) {
        return {
            status: 'error',
            workspaceId: a.workspaceId,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

export interface AssignmentReconcileResult {
    provisioned: string[];
    existing: string[];
    errors: string[];
}

/**
 * RECONCILE a full assigned-workspace list (the one-shot on (re)connect): provision
 * each not-yet-local one. Best-effort per workspace. This is NOT a poll — the
 * caller runs it ONCE per connection, off the transport's `onConnected`.
 */
export async function reconcileAssignedWorkspaces(
    assignments: WorkspaceAssignment[],
    deps: AssignmentProvisionDeps,
): Promise<AssignmentReconcileResult> {
    const out: AssignmentReconcileResult = { provisioned: [], existing: [], errors: [] };
    for (const a of assignments) {
        const r = await provisionAssignedWorkspace(a, deps);
        if (r.status === 'provisioned') out.provisioned.push(r.workspaceId);
        else if (r.status === 'exists') out.existing.push(r.workspaceId);
        else out.errors.push(`${a.name}: ${r.error}`);
    }
    return out;
}

/** A live subscription handle — closing it drops the ONE persistent connection. */
export interface AssignmentSubscriptionHandle {
    close(): void;
}

/**
 * The persistent push carrier, injected by the shell. `onConnected` fires on
 * every (re)connect (the trigger for the one-shot reconcile); `onAssignment`
 * fires per pushed `WorkspaceAssigned`. Implementations MUST hold ONE persistent
 * connection and MUST NOT poll.
 */
export interface AssignmentTransport {
    open(handlers: {
        onConnected: () => void;
        onAssignment: (a: WorkspaceAssignment) => void;
    }): AssignmentSubscriptionHandle;
}

export interface WorkspaceAssignmentSubscriberDeps {
    transport: AssignmentTransport;
    /** One-shot reconcile (fetch the assigned list + provision the diff). */
    reconcile: () => Promise<void>;
    /** Provision one pushed assignment. */
    provision: (a: WorkspaceAssignment) => Promise<void>;
    /** Surfaced for logging; a failed reconcile/provision never tears down the sub. */
    onError?: (context: 'reconcile' | 'provision', e: unknown) => void;
}

/**
 * Orchestrates the push subscription: on each (re)connect run the one-shot
 * reconcile; on each push provision that one workspace. NO timers, NO polling —
 * the injected transport is the single long-lived connection.
 */
export class WorkspaceAssignmentSubscriber {
    private handle: AssignmentSubscriptionHandle | null = null;

    constructor(private readonly deps: WorkspaceAssignmentSubscriberDeps) {}

    start(): void {
        if (this.handle) return;
        this.handle = this.deps.transport.open({
            onConnected: () => void this.guard('reconcile', this.deps.reconcile()),
            onAssignment: (a) => void this.guard('provision', this.deps.provision(a)),
        });
    }

    stop(): void {
        this.handle?.close();
        this.handle = null;
    }

    private async guard(context: 'reconcile' | 'provision', p: Promise<void>): Promise<void> {
        try {
            await p;
        } catch (e) {
            this.deps.onError?.(context, e);
        }
    }
}

/** Everything the shell supplies to wire a live subscriber. */
export interface WorkspaceAssignmentWiring {
    /** The persistent push carrier (Pusher on Tynn's private channel). */
    transport: AssignmentTransport;
    /** Fetch this host's assigned workspaces (the host-authed reconcile endpoint).
     *  Injected because it needs the host token + Tynn base URL the shell holds. */
    fetchAssigned: () => Promise<WorkspaceAssignment[]>;
    /** Where assigned envelopes clone to (`<parent>/<slug>`). */
    parentPath: string;
    /** Optional provision-seam overrides (tests / custom env-file). */
    provisionDeps?: Partial<AssignmentProvisionDeps>;
    onError?: (context: 'reconcile' | 'provision', e: unknown) => void;
}

/**
 * Assemble a ready-to-start subscriber from the shell's wiring. The reconcile
 * closure fetches the assigned list then provisions the diff; the provision
 * closure handles a single push. Both reuse the same provision seams.
 */
export function createWorkspaceAssignmentSubscriber(
    w: WorkspaceAssignmentWiring,
): WorkspaceAssignmentSubscriber {
    const deps: AssignmentProvisionDeps = { parentPath: w.parentPath, ...w.provisionDeps };
    return new WorkspaceAssignmentSubscriber({
        transport: w.transport,
        reconcile: async () => {
            const list = await w.fetchAssigned();
            await reconcileAssignedWorkspaces(list, deps);
        },
        provision: async (a) => {
            await provisionAssignedWorkspace(a, deps);
        },
        onError: w.onError,
    });
}
