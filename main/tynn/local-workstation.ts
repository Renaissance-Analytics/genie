import { TynnBackend } from '../backend/tynn';
import { applyPushedDelta, setIssueWatchServiceState, type PushedIssueWatchDelta } from '../issue-watch';
import {
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
 * that endpoint is deployed `fromTynn` yields null and the IssueWatch push simply
 * stays off — IssueWatch falls back to its local GitHub poller, so there is no
 * regression, just no server-fed acceleration yet.
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
    /** The user's FMS toggles. Default: backend.fetchFeatures(). */
    features?: () => Promise<{ issuewatch: boolean; whisperchat: boolean }>;
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
    log?: (msg: string) => void;
}

export interface LocalWorkstationHandle {
    workstationId: string;
    stop(): void;
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
    if (!res.ok) throw new Error(`issue-watch reconcile failed: HTTP ${res.status}`);
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
        const { workstationId, status } = await ensure();
        log(`workstation ${status}: ${workstationId}`);

        const identity = (deps.identity ?? (() => readWorkstationIdentity()))();
        if (!identity) {
            log('no workstation identity after enroll — IssueWatch push off');
            return null;
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
        const tynnApiBaseUrl = (deps.tynnApiBaseUrl ?? (() => backend.host()))();
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
                void (async () => {
                    try {
                        const deltas = await fetchSnapshot(identity, tynnApiBaseUrl);
                        for (const d of deltas) applyDelta(d);
                        log(`reconciled ${deltas.length} workspace IssueWatch snapshot(s)`);
                    } catch (e) {
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
            onDisconnected: () => setIssueWatchServiceState('disconnected'),
        });

        log(`subscribed to private-workstation.${identity.workstationId}`);
        return { workstationId: identity.workstationId, stop: () => handle.close() };
    } catch (e) {
        log(`startLocalWorkstation failed: ${e instanceof Error ? e.message : String(e)}`);
        setIssueWatchServiceState('disconnected');
        return null;
    }
}
