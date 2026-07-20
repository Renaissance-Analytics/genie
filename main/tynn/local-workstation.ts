import { TynnBackend } from '../backend/tynn';
import {
    applyPushedDelta,
    setIssueWatchServiceState,
    setReconcileDelivered,
    type PushedIssueWatchDelta,
} from '../issue-watch';
import {
    clearWorkstationIdentity,
    ensureLocalWorkstation,
    readWorkstationIdentity,
    type WorkstationIdentity,
} from './workstation-identity';
import { toIssueWatchDelta } from './pusher-protocol';
import {
    WorkstationPusherTransport,
    type WorkstationSubscriptionHandle,
} from './pusher-transport';
import type { IssueWatchDeltaPush } from './workspace-assignment';

/**
 * The LOCAL-workstation client (design brief genie-service-separation §2a).
 *
 * On boot the desktop shell calls {@link startLocalWorkstation}. It:
 *   1. ensures this machine is a self-registered, enrolled Tynn Workstation
 *      (#2 — `ensureLocalWorkstation`, idempotent, FREE + uncapped);
 *   2. checks the user's FMS toggles — only proceeds when `issuewatch` is ON;
 *   3. resolves the (public) Pusher app key + cluster;
 *   4. opens ONE persistent subscription to this workstation's OWN
 *      `private-workstation.{id}` channel (host-authed broadcasting-auth);
 *   5. on every (re)connect, reconciles the server-side IssueWatch snapshot
 *      (`GET /api/v1/workstations/{id}/issue-watch`) and, per pushed
 *      `issuewatch.delta`, feeds `issueWatch.applyPushedDelta` (#197, reused
 *      verbatim) — so a LOCAL Genie stops polling GitHub, exactly like a cloud
 *      host. No polling anywhere: one socket + Pusher's idle pings.
 *
 * Everything is injectable so the flow is unit-tested with fakes (no electron, no
 * network, no sockets); the defaults wire the real backend / identity / transport.
 */

export interface BroadcastConfig {
    appKey: string;
    cluster: string;
}

/**
 * Resolve the PUBLIC Pusher app key + cluster the local workstation subscribes
 * with. Priority:
 *   1. an explicit env override — `GENIE_PUSHER_APP_KEY` / `GENIE_PUSHER_CLUSTER`
 *      (dev / self-host; mirrors how genie-cloud reads its host env);
 *   2. Tynn (`fromTynn`) — the durable source.
 *
 * TODO(genie-service-separation §2a): Tynn should expose its PUBLIC broadcast app
 * key + cluster (the same `VITE_PUSHER_APP_KEY` its own web bundle already ships —
 * a Pusher app key is public, it rides every browser) via a small session-authed
 * endpoint, so a local workstation subscribes without any build-time config. Until
 * that endpoint is deployed `fromTynn` yields null and the IssueWatch push stays
 * off — which means NO FEED AT ALL. There is no local-poller fallback: Tynn is the
 * only IssueWatch source since the hard cut. (The comment here used to claim a
 * fallback existed; it did not, and that claim helped hide a dead feed — genie#22.)
 */
export async function resolveBroadcastConfig(deps: {
    env?: NodeJS.ProcessEnv;
    fromTynn?: () => Promise<{ key: string; cluster?: string } | null>;
}): Promise<BroadcastConfig | null> {
    const env = deps.env ?? process.env;
    const envKey = env.GENIE_PUSHER_APP_KEY?.trim();
    if (envKey) {
        return { appKey: envKey, cluster: env.GENIE_PUSHER_CLUSTER?.trim() || 'us2' };
    }
    const fromTynn = deps.fromTynn ? await deps.fromTynn() : null;
    if (fromTynn?.key) return { appKey: fromTynn.key, cluster: fromTynn.cluster?.trim() || 'us2' };
    return null;
}

/**
 * Parse a `GET /api/v1/workstations/{id}/issue-watch` reconcile snapshot into a
 * per-workspace delta list. Tolerant of shape (the server side is held) — accepts
 * `{ workspaces: [...] }`, coercing each row through the shared `toIssueWatchDelta`
 * and dropping rows with no usable workspace id. Pure.
 */
export function parseIssueWatchSnapshot(body: unknown): IssueWatchDeltaPush[] {
    if (!body || typeof body !== 'object') return [];
    const rows = (body as { workspaces?: unknown }).workspaces;
    if (!Array.isArray(rows)) return [];
    return rows
        .map((r) => toIssueWatchDelta(r))
        .filter((d): d is IssueWatchDeltaPush => d !== null);
}

/** The transport surface the orchestration drives — the real
 *  {@link WorkstationPusherTransport} satisfies it; tests pass a fake. */
export interface WorkstationTransportLike {
    open(handlers: {
        onConnected: () => void;
        onIssueWatchDelta: (delta: IssueWatchDeltaPush) => void;
        onDisconnected?: () => void;
    }): WorkstationSubscriptionHandle;
}

export interface StartLocalWorkstationDeps {
    /** The Tynn backend (self-register / enroll / features). Default: new TynnBackend(). */
    backend?: TynnBackend;
    /** Idempotent self-register + enroll (#2). Default: ensureLocalWorkstation(backend). */
    ensure?: () => Promise<{ status: 'exists' | 'enrolled'; workstationId: string }>;
    /** Read the persisted identity (the host signer). Default: readWorkstationIdentity(). */
    identity?: () => WorkstationIdentity | null;
    /** Clear a rejected identity before a one-time re-enrollment. */
    resetIdentity?: () => void;
    /** The user's FMS toggles. Default: backend.fetchFeatures(). */
    features?: () => Promise<{ issuewatch: boolean; agentinbox: boolean }>;
    /** Resolve the Pusher app key + cluster. Default: env → Tynn (resolveBroadcastConfig). */
    broadcastConfig?: () => Promise<BroadcastConfig | null>;
    /** Tynn API base URL. Default: backend.host(). */
    tynnApiBaseUrl?: () => string;
    /** Build the transport. Default: real WorkstationPusherTransport. */
    makeTransport?: (opts: {
        appKey: string;
        cluster: string;
        workstationId: string;
        tynnApiBaseUrl: string;
        signer: { authHeader(): string };
    }) => WorkstationTransportLike;
    /** Fetch the reconcile snapshot. Default: host-authed GET .../issue-watch. */
    fetchSnapshot?: (identity: WorkstationIdentity, tynnApiBaseUrl: string) => Promise<IssueWatchDeltaPush[]>;
    /** Apply one delta to the issue-watch store. Default: issueWatch.applyPushedDelta (#197). */
    applyDelta?: (delta: IssueWatchDeltaPush) => void;
    /** Injectable fetch for the snapshot (host-authed, no cookies). Default: global fetch. */
    fetchImpl?: typeof fetch;
    /** Current local workspace + enabled-site inventory. Synced to Tynn with
     * workstation auth so share policy never depends on a Tynn project row. */
    inventory?: () => Promise<WorkstationInventory>;
    log?: (msg: string) => void;
}

export interface WorkstationInventory {
    workspaces: Array<{
        id: string;
        name: string;
        projectId?: string | null;
        sites: Array<{ id: string; name: string; hostname: string }>;
    }>;
}

export interface LocalWorkstationHandle {
    workstationId: string;
    stop(): void;
}

export class WorkstationHostHttpError extends Error {
    constructor(
        public readonly status: number,
        operation: string,
    ) {
        super(`${operation} failed: HTTP ${status}`);
        this.name = 'WorkstationHostHttpError';
    }
}

function isStaleWorkstationError(error: unknown): boolean {
    // A 404 definitively means Tynn no longer has this workstation row. A 401
    // can also be caused by clock skew, so rotating credentials would not help.
    return error instanceof WorkstationHostHttpError && error.status === 404;
}

export async function syncWorkstationInventory(
    identity: WorkstationIdentity,
    tynnApiBaseUrl: string,
    inventory: WorkstationInventory,
    fetchImpl: typeof fetch,
): Promise<void> {
    const base = tynnApiBaseUrl.replace(/\/+$/, '');
    const url = `${base}/api/v1/workstations/${encodeURIComponent(identity.workstationId)}/inventory`;
    const body = JSON.stringify({
        workspaces: inventory.workspaces.map((workspace) => ({
            workspace_id: workspace.id,
            name: workspace.name,
            project_id: workspace.projectId || null,
            sites: workspace.sites.map((site) => ({
                site_id: site.id,
                name: site.name,
                hostname: site.hostname,
            })),
        })),
    });
    const res = await fetchImpl(url, {
        method: 'PUT',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: identity.authHeader(),
        },
        body,
    });
    if (!res.ok) throw new WorkstationHostHttpError(res.status, 'workstation inventory sync');
}

/**
 * Host-authed reconcile fetch: `GET /api/v1/workstations/{id}/issue-watch`, signed
 * with the Ed25519 workstation proof (no cookies — global fetch). Returns the
 * per-workspace deltas the caller applies. Throws on a non-2xx (the caller logs
 * and the next (re)connect retries).
 */
async function defaultFetchSnapshot(
    identity: WorkstationIdentity,
    tynnApiBaseUrl: string,
    fetchImpl: typeof fetch,
): Promise<IssueWatchDeltaPush[]> {
    const base = tynnApiBaseUrl.replace(/\/+$/, '');
    const url = `${base}/api/v1/workstations/${encodeURIComponent(identity.workstationId)}/issue-watch`;
    const res = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: identity.authHeader() },
    });
    if (!res.ok) throw new WorkstationHostHttpError(res.status, 'issue-watch reconcile');
    return parseIssueWatchSnapshot(await res.json());
}

/**
 * Stand up the local-workstation IssueWatch client. Returns a handle (to stop the
 * subscription) or null when the client did NOT start — not enrolled, IssueWatch
 * toggled off, or no broadcast config resolved. Best-effort at every step: any
 * failure logs and returns null rather than throwing, so a boot never breaks.
 */
export async function startLocalWorkstation(
    deps: StartLocalWorkstationDeps = {},
): Promise<LocalWorkstationHandle | null> {
    const log = deps.log ?? (() => {});
    const backend = deps.backend ?? new TynnBackend();
    const fetchImpl = deps.fetchImpl ?? fetch;
    setIssueWatchServiceState('connecting');

    try {
        // 1) Idempotent self-register + enroll (#2).
        const ensure = deps.ensure ?? (() => ensureLocalWorkstation(backend));
        let { workstationId, status } = await ensure();
        log(`workstation ${status}: ${workstationId}`);

        const readIdentity = deps.identity ?? (() => readWorkstationIdentity());
        let identity = readIdentity();
        if (!identity) {
            log('no workstation identity after enroll — IssueWatch push off');
            // Terminal for this boot — otherwise state is stuck at 'connecting'
            // forever (we never subscribe), reading as "still connecting…".
            setIssueWatchServiceState('disconnected');
            return null;
        }
        const tynnApiBaseUrl = (deps.tynnApiBaseUrl ?? (() => backend.host()))();
        const syncInventory = async (currentIdentity: WorkstationIdentity): Promise<void> => {
            if (!deps.inventory) return;
            await syncWorkstationInventory(currentIdentity, tynnApiBaseUrl, await deps.inventory(), fetchImpl);
        };
        try {
            await syncInventory(identity);
            if (deps.inventory) log('workstation inventory synced');
        } catch (e) {
            if (status === 'exists' && isStaleWorkstationError(e)) {
                log('saved workstation identity was rejected by Tynn — re-enrolling once');
                (deps.resetIdentity ?? clearWorkstationIdentity)();
                ({ workstationId, status } = await ensure());
                identity = readIdentity();
                if (!identity) {
                    log('no workstation identity after re-enrollment — IssueWatch push off');
                    setIssueWatchServiceState('disconnected');
                    return null;
                }
                await syncInventory(identity);
                if (deps.inventory) log('workstation inventory synced after re-enrollment');
            } else {
                log(`inventory sync failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // 2) FMS gate — only ride the channel when IssueWatch is entitled.
        const features = await (deps.features ?? (() => backend.fetchFeatures()))();
        if (!features.issuewatch) {
            log('IssueWatch feature off (FMS) — not subscribing');
            setIssueWatchServiceState('disabled');
            return null;
        }

        // 3) The (public) Pusher app key + cluster — env override → Tynn.
        const cfg = await (deps.broadcastConfig ??
            (() =>
                resolveBroadcastConfig({
                    env: process.env,
                    fromTynn: () => backend.fetchBroadcastConfig(),
                })))();
        if (!cfg) {
            log('no Pusher broadcast config resolved — IssueWatch disconnected');
            setIssueWatchServiceState('disconnected');
            return null;
        }

        // 4) One persistent subscription to our OWN workstation channel.
        const transport: WorkstationTransportLike = deps.makeTransport
            ? deps.makeTransport({
                  appKey: cfg.appKey,
                  cluster: cfg.cluster,
                  workstationId: identity.workstationId,
                  tynnApiBaseUrl,
                  signer: { authHeader: () => identity.authHeader() },
              })
            : new WorkstationPusherTransport({
                  appKey: cfg.appKey,
                  cluster: cfg.cluster,
                  workstationId: identity.workstationId,
                  tynnApiBaseUrl,
                  signer: { authHeader: () => identity.authHeader() },
                  log,
              });

        const fetchSnapshot =
            deps.fetchSnapshot ??
            ((id: WorkstationIdentity, base: string) => defaultFetchSnapshot(id, base, fetchImpl));
        const applyDelta =
            deps.applyDelta ??
            ((d: IssueWatchDeltaPush) => applyPushedDelta(d as unknown as PushedIssueWatchDelta));

        const handle = transport.open({
            // On every (re)connect: reconcile the full server-side snapshot so a
            // workspace whose delta was pushed while we were offline is caught up.
            onConnected: () => {
                setIssueWatchServiceState('connected');
                // Channel is up, but the feed lands with the reconcile below —
                // gate 'connected' reads until it does (re-gate on every connect).
                setReconcileDelivered(false);
                void (async () => {
                    try {
                        await syncInventory(identity);
                        const deltas = await fetchSnapshot(identity, tynnApiBaseUrl);
                        for (const d of deltas) applyDelta(d);
                        // First snapshot in hand (even if empty = genuinely nothing) —
                        // now reads honestly report connected instead of "loading".
                        setReconcileDelivered(true);
                        log(`reconciled ${deltas.length} workspace IssueWatch snapshot(s)`);
                    } catch (e) {
                        // Leave the gate closed — a reconnect re-reconciles, and a
                        // live delta flips it if one arrives first.
                        log(`issue-watch reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                })();
            },
            // Each live push: feed the issue-watch store (it stores + rebroadcasts).
            onIssueWatchDelta: (delta) => {
                try {
                    applyDelta(delta);
                } catch (e) {
                    log(`applyPushedDelta failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            },
            // A transport drop always schedules a re-dial (see onDrop), so the
            // honest state is 'connecting', not a terminal 'disconnected' — the
            // give-up paths (no config / startup catch) set 'disconnected' directly.
            onDisconnected: () => setIssueWatchServiceState('connecting'),
        });

        log(`subscribed to private-workstation.${identity.workstationId}`);
        return { workstationId: identity.workstationId, stop: () => handle.close() };
    } catch (e) {
        log(`startLocalWorkstation failed: ${e instanceof Error ? e.message : String(e)}`);
        setIssueWatchServiceState('disconnected');
        return null;
    }
}
