import {
    addWorkspace,
    getAllSettings,
    getWorkspace,
    listAssignmentWorkspaces,
    listWorkspaces,
    removeWorkspace,
} from '../db';
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
    clone?: (opts: {
        url: string;
        parent_path: string;
        folder: string;
        token?: string | null;
    }) => Promise<{ path: string }>;
    /**
     * Resolve a short-lived GitHub token to clone `url` with (genie #47). A headless
     * host (genie-cloud) has no desktop OAuth token, so the shell injects this to
     * fetch a repo-scoped GitHub App installation token from Tynn's workstation
     * git-credential endpoint, keyed on the envelope's owner. Returns null when no
     * credential covers the repo (falls back to ambient git auth — fine for a public
     * envelope). Omitted on the desktop, where `cloneAgiEnvelope`'s own getToken() is
     * used. Best-effort: a fetch failure must not abort provisioning.
     */
    getCloneToken?: (url: string) => Promise<string | null>;
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
        // Resolve a clone credential when the shell provides a fetcher (headless
        // host, genie #47). Best-effort: a fetch failure resolves to no token, so a
        // public envelope still clones via ambient auth rather than aborting.
        let token: string | null | undefined;
        if (deps.getCloneToken) {
            token = await deps.getCloneToken(url).catch(() => null);
        }
        const { path: wsPath } = await clone({
            url,
            parent_path: deps.parentPath,
            folder: a.slug,
            ...(token !== undefined ? { token } : {}),
        });
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
            // Mark it assignment-managed so the convergent reconcile may safely
            // deprovision it later — this is the ONLY flow that sets this flag.
            assignment_managed: 1,
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

/** Injectable seams for the SAFE teardown side (DETACH), defaulting to the real
 *  db / terminal / broadcast so callers pass nothing; tests pass fakes. */
export interface AssignmentDeprovisionDeps {
    /** This host's assignment-managed workspaces (default: listAssignmentWorkspaces).
     *  Deprovision only ever touches an id present here — a user-local or an
     *  ops-provisioned workspace (identical backend/created_by_genie) is invisible
     *  to it, so it can never be torn down. */
    listManaged?: () => Array<{ id: string }>;
    /** Whether a workspace row exists at all (default: getWorkspace). Distinguishes
     *  a present-but-unmanaged row (SKIPPED for safety) from a genuinely absent one
     *  (an idempotent no-op — a duplicate push). */
    hasWorkspace?: (id: string) => boolean;
    /** Fully stop + tear down the workspace's terminals (default: the real
     *  stopWorkspaceTerminals, lazy-required so this module stays electron-free at
     *  import — unit tests inject this and never reach the require). */
    stopTerminals?: (workspaceId: string) => string[];
    /** Unregister the workspace row — LEAVES the on-disk clone (default: removeWorkspace). */
    remove?: (id: string) => void;
    /** Announce the workspace-list change to clients (default: broadcastWorkspacesChanged). */
    notifyChanged?: () => void;
}

export type AssignmentDeprovisionStatus = 'deprovisioned' | 'absent' | 'skipped';

export interface AssignmentDeprovisionResult {
    status: AssignmentDeprovisionStatus;
    workspaceId: string;
    /** The terminals torn down, when deprovisioned. */
    stopped?: string[];
}

/**
 * SAFELY deprovision ONE unassigned workspace (the DETACH mirror of
 * provisionAssignedWorkspace): stop its terminals/agents (full teardown, no
 * orphans), unregister the row, and broadcast — LEAVING the on-disk clone in
 * place (uncommitted work is never destroyed). Synchronous + best-effort.
 *
 * SAFETY: only a workspace THIS host provisioned from a Tynn assignment
 * (`assignment_managed`) is ever torn down. A present-but-unmanaged row (a
 * user-local or ops-provisioned workspace) is refused → `skipped`. An id with no
 * local row is an idempotent no-op → `absent` (a duplicate push is harmless).
 */
export function deprovisionAssignedWorkspace(
    workspaceId: string,
    deps: AssignmentDeprovisionDeps = {},
): AssignmentDeprovisionResult {
    const listManaged = deps.listManaged ?? listAssignmentWorkspaces;
    const hasWorkspace = deps.hasWorkspace ?? ((id: string) => !!getWorkspace(id));
    const stopTerminals =
        deps.stopTerminals ??
        ((id: string): string[] =>
            // Lazy require keeps this module electron-free at import (unit tests
            // inject stopTerminals; only the real host reaches this).
            (require('../terminal/ipc') as typeof import('../terminal/ipc')).stopWorkspaceTerminals(id));
    const remove = deps.remove ?? removeWorkspace;
    const notifyChanged = deps.notifyChanged ?? broadcastWorkspacesChanged;

    if (!workspaceId) return { status: 'absent', workspaceId };

    if (!listManaged().some((w) => w.id === workspaceId)) {
        // Not assignment-managed: refuse if the row exists (safety), else no-op.
        return { status: hasWorkspace(workspaceId) ? 'skipped' : 'absent', workspaceId };
    }

    const stopped = stopTerminals(workspaceId);
    remove(workspaceId);
    // The same broadcast attach uses — remote sessions re-fetch and fade it OUT.
    notifyChanged();
    return { status: 'deprovisioned', workspaceId, stopped };
}

export interface AssignmentReconcileResult {
    provisioned: string[];
    existing: string[];
    errors: string[];
    /** Assignment-managed workspaces removed because Tynn no longer assigns them. */
    deprovisioned: string[];
}

/**
 * RECONCILE a full assigned-workspace list against local state (the one-shot on
 * (re)connect) — CONVERGENT in both directions: provision each not-yet-local
 * assignment AND deprovision each assignment-managed local workspace Tynn no
 * longer assigns (the offline-catch-up for a detach whose push was missed).
 * Best-effort per workspace. NOT a poll — the caller runs it ONCE per connection,
 * off the transport's `onConnected`.
 */
export async function reconcileAssignedWorkspaces(
    assignments: WorkspaceAssignment[],
    deps: AssignmentProvisionDeps & AssignmentDeprovisionDeps,
): Promise<AssignmentReconcileResult> {
    const out: AssignmentReconcileResult = {
        provisioned: [],
        existing: [],
        errors: [],
        deprovisioned: [],
    };

    // 1) ADD: provision every assignment not yet local.
    for (const a of assignments) {
        const r = await provisionAssignedWorkspace(a, deps);
        if (r.status === 'provisioned') out.provisioned.push(r.workspaceId);
        else if (r.status === 'exists') out.existing.push(r.workspaceId);
        else out.errors.push(`${a.name}: ${r.error}`);
    }

    // 2) CONVERGE: remove assignment-managed locals absent from the assigned set.
    const assignedIds = new Set(assignments.map((a) => a.workspaceId));
    const listManaged = deps.listManaged ?? listAssignmentWorkspaces;
    for (const w of listManaged()) {
        if (assignedIds.has(w.id)) continue;
        const r = deprovisionAssignedWorkspace(w.id, deps);
        if (r.status === 'deprovisioned') out.deprovisioned.push(w.id);
    }
    return out;
}

/** A live subscription handle — closing it drops the ONE persistent connection. */
export interface AssignmentSubscriptionHandle {
    close(): void;
}

/**
 * The persistent push carrier, injected by the shell. `onConnected` fires on
 * every (re)connect (the trigger for the one-shot convergent reconcile);
 * `onAssignment` per pushed `WorkspaceAssigned`; `onUnassignment` per pushed
 * `WorkspaceUnassigned` (the DETACH trigger — the id to deprovision).
 * Implementations MUST hold ONE persistent connection and MUST NOT poll.
 */
/**
 * A server-side IssueWatch delta pushed from Tynn (per workspace) — the
 * `issuewatch.delta` payload the shell's transport decodes. `items` stays opaque
 * here (the issue-watch module owns the shape); this module only routes it.
 */
export interface IssueWatchDeltaPush {
    workspaceId: string;
    projectId: string;
    counts: { issue: number; pr: number; security: number };
    items: unknown[];
}

export interface AssignmentTransport {
    open(handlers: {
        onConnected: () => void;
        onAssignment: (a: WorkspaceAssignment) => void;
        /** Optional so older transports still satisfy the type; the subscriber
         *  always supplies it. */
        onUnassignment?: (workspaceId: string) => void;
        /** Optional server-side IssueWatch delta (counts/items) for a workspace —
         *  routed to the issue-watch module so the client stops polling GitHub. */
        onIssueWatchDelta?: (delta: IssueWatchDeltaPush) => void;
    }): AssignmentSubscriptionHandle;
}

export type AssignmentSubscriberContext = 'reconcile' | 'provision' | 'deprovision';

export interface WorkspaceAssignmentSubscriberDeps {
    transport: AssignmentTransport;
    /** One-shot convergent reconcile (fetch the assigned list; provision the
     *  additions AND deprovision the removals). */
    reconcile: () => Promise<void>;
    /** Provision one pushed assignment. */
    provision: (a: WorkspaceAssignment) => Promise<void>;
    /** Safely deprovision one pushed unassignment (the DETACH trigger). */
    deprovision: (workspaceId: string) => Promise<void>;
    /** Route a server-side IssueWatch delta to the issue-watch module (injected —
     *  keeps this module electron-free; the shell supplies issueWatch.applyPushedDelta). */
    applyIssueWatchDelta?: (delta: IssueWatchDeltaPush) => void;
    /** Drop a workspace's server-fed IssueWatch snapshot (on unassignment). */
    clearIssueWatchDelta?: (workspaceId: string) => void;
    /** Surfaced for logging; a failed step never tears down the sub. */
    onError?: (context: AssignmentSubscriberContext, e: unknown) => void;
}

/**
 * Orchestrates the push subscription: on each (re)connect run the one-shot
 * convergent reconcile; on each assignment push provision that workspace; on each
 * unassignment push safely deprovision it. NO timers, NO polling — the injected
 * transport is the single long-lived connection.
 */
export class WorkspaceAssignmentSubscriber {
    private handle: AssignmentSubscriptionHandle | null = null;

    constructor(private readonly deps: WorkspaceAssignmentSubscriberDeps) {}

    start(): void {
        if (this.handle) return;
        this.handle = this.deps.transport.open({
            onConnected: () => void this.guard('reconcile', this.deps.reconcile()),
            onAssignment: (a) => void this.guard('provision', this.deps.provision(a)),
            onUnassignment: (workspaceId) => {
                // Detach: tear the workspace down AND drop its server-fed IssueWatch.
                this.deps.clearIssueWatchDelta?.(workspaceId);
                void this.guard('deprovision', this.deps.deprovision(workspaceId));
            },
            // Server-side IssueWatch: route the delta to the issue-watch module —
            // synchronous, never throws (the module just stores + rebroadcasts).
            onIssueWatchDelta: this.deps.applyIssueWatchDelta
                ? (delta) => this.deps.applyIssueWatchDelta?.(delta)
                : undefined,
        });
    }

    stop(): void {
        this.handle?.close();
        this.handle = null;
    }

    private async guard(context: AssignmentSubscriberContext, p: Promise<void>): Promise<void> {
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
    /** Resolve a short-lived clone credential for an envelope URL (genie #47).
     *  Injected because it needs the Ed25519 host signer + Tynn base the shell
     *  holds. Absent on the desktop (its clone uses the local getToken()). */
    getCloneToken?: (url: string) => Promise<string | null>;
    /** Where assigned envelopes clone to (`<parent>/<slug>`). */
    parentPath: string;
    /** Optional provision/deprovision-seam overrides (tests / custom env-file). */
    provisionDeps?: Partial<AssignmentProvisionDeps & AssignmentDeprovisionDeps>;
    /** Route server-side IssueWatch deltas to the issue-watch module (the shell
     *  injects issueWatch.applyPushedDelta / clearPushedDelta — keeps this seam
     *  electron-free). Absent ⇒ deltas are simply ignored. */
    applyIssueWatchDelta?: (delta: IssueWatchDeltaPush) => void;
    clearIssueWatchDelta?: (workspaceId: string) => void;
    onError?: (context: AssignmentSubscriberContext, e: unknown) => void;
}

/**
 * Assemble a ready-to-start subscriber from the shell's wiring. The reconcile
 * closure fetches the assigned list then converges local state (provision the
 * additions, deprovision the removals); the provision/deprovision closures handle
 * single pushes. All reuse the same seams.
 */
export function createWorkspaceAssignmentSubscriber(
    w: WorkspaceAssignmentWiring,
): WorkspaceAssignmentSubscriber {
    const deps: AssignmentProvisionDeps & AssignmentDeprovisionDeps = {
        parentPath: w.parentPath,
        ...(w.getCloneToken ? { getCloneToken: w.getCloneToken } : {}),
        ...w.provisionDeps,
    };
    return new WorkspaceAssignmentSubscriber({
        transport: w.transport,
        reconcile: async () => {
            const list = await w.fetchAssigned();
            const r = await reconcileAssignedWorkspaces(list, deps);
            // Observability: the reconcile is otherwise silent on success, so a host
            // that saw ZERO assignments (e.g. a wrong/duplicate workstation id) looked
            // identical to one that provisioned fine. Log what it actually did.
            console.log(
                `[workspace-assignment] reconcile: ${list.length} assigned → ` +
                    `provisioned ${r.provisioned.length}, existing ${r.existing.length}, ` +
                    `deprovisioned ${r.deprovisioned.length}` +
                    (r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''),
            );
        },
        provision: async (a) => {
            const r = await provisionAssignedWorkspace(a, deps);
            console.log(
                `[workspace-assignment] provision ${a.workspaceId} (${a.name}): ${r.status}` +
                    (r.error ? ` — ${r.error}` : r.path ? ` → ${r.path}` : ''),
            );
        },
        deprovision: async (workspaceId) => {
            deprovisionAssignedWorkspace(workspaceId, deps);
        },
        applyIssueWatchDelta: w.applyIssueWatchDelta,
        clearIssueWatchDelta: w.clearIssueWatchDelta,
        onError: w.onError,
    });
}
