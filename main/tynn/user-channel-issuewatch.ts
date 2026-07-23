import { TynnBackend } from '../backend/tynn';
import { applyPushedDelta, type PushedIssueWatchDelta } from '../issue-watch';
import {
    parseIssueWatchSnapshot,
    resolveBroadcastConfig,
    type BroadcastConfig,
    type WorkstationTransportLike,
} from './local-workstation';
import { userChannel } from './pusher-protocol';
import { WorkstationPusherTransport } from './pusher-transport';
import type { IssueWatchDeltaPush } from './workspace-assignment';

/**
 * The USER-CHANNEL IssueWatch client (design brief genie-service-separation
 * Phase 2b). This runs ALONGSIDE {@link startLocalWorkstation} — it does NOT
 * replace it. Where the workstation path holds this machine's own
 * `private-workstation.{id}` channel (host-proof authed), this holds the signed-in
 * user's PERSONAL `private-App.Models.User.{id}` channel, so a personal desktop
 * receives the same server-side `issuewatch.delta` push with no workstation row at
 * all.
 *
 * It:
 *   1. resolves the signed-in user's id (`backend.whoami()`);
 *   2. resolves the (public) Pusher app key + cluster (env → Tynn, shared with the
 *      workstation path via {@link resolveBroadcastConfig});
 *   3. opens ONE persistent subscription to `private-App.Models.User.{id}`,
 *      authorizing each socket via `POST /api/v1/user/broadcasting-auth` with the
 *      desktop's Tynn SESSION cookie (the injected session-bound fetch);
 *   4. on every (re)connect, reconciles the user-scoped snapshot
 *      (`GET /api/v1/user/issue-watch`) and, per pushed `issuewatch.delta`, feeds
 *      `issueWatch.applyPushedDelta` (#197, reused verbatim). `applyPushedDelta`
 *      is idempotent, so overlapping with the workstation path is safe.
 *
 * The push-channel service STATE (`setIssueWatchServiceState`) stays owned by the
 * workstation path — this parallel client never touches it, so the two never fight
 * over the shared indicator. Everything is injectable so the flow is unit-tested
 * with fakes (no electron, no network, no sockets).
 */

export interface StartUserChannelIssueWatchDeps {
    /** The Tynn backend (whoami / broadcast config). Default: new TynnBackend(). */
    backend?: TynnBackend;
    /** Resolve the signed-in user's id. Default: backend.whoami(). */
    whoami?: () => Promise<{ id: string } | null>;
    /** Resolve the Pusher app key + cluster. Default: env → Tynn (resolveBroadcastConfig). */
    broadcastConfig?: () => Promise<BroadcastConfig | null>;
    /** Tynn API base URL. Default: backend.host(). */
    tynnApiBaseUrl?: () => string;
    /** Build the transport. Default: real WorkstationPusherTransport on the user channel. */
    makeTransport?: (opts: {
        appKey: string;
        cluster: string;
        channel: string;
        authorize: (socketId: string) => Promise<string>;
        tynnApiBaseUrl: string;
    }) => WorkstationTransportLike;
    /** Fetch the reconcile snapshot. Default: session-authed GET /api/v1/user/issue-watch. */
    fetchSnapshot?: (tynnApiBaseUrl: string) => Promise<IssueWatchDeltaPush[]>;
    /** Apply one delta to the issue-watch store. Default: issueWatch.applyPushedDelta (#197). */
    applyDelta?: (delta: IssueWatchDeltaPush) => void;
    /**
     * Session-bound fetch that carries the desktop's Tynn cookies (genie_token +
     * laravel_session). In production this is `session.defaultSession.fetch`; tests
     * inject a stub. Default: global fetch (cookie-less — real callers MUST pass the
     * session fetch or auth 401s).
     */
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
}

export interface UserChannelIssueWatchHandle {
    userId: string;
    stop(): void;
}

/** POST the desktop's Tynn session to `/api/v1/user/broadcasting-auth` for this
 *  socket + the user's personal channel; returns the Pusher auth string. */
async function authorizeUserChannel(
    socketId: string,
    channel: string,
    tynnApiBaseUrl: string,
    fetchImpl: typeof fetch,
): Promise<string> {
    const base = tynnApiBaseUrl.replace(/\/+$/, '');
    const url = `${base}/api/v1/user/broadcasting-auth`;
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ socket_id: socketId, channel_name: channel }),
    });
    if (!res.ok) throw new Error(`user broadcasting-auth HTTP ${res.status}`);
    const body = (await res.json()) as { auth?: unknown };
    if (typeof body.auth !== 'string' || body.auth === '') {
        throw new Error('user broadcasting-auth returned no auth');
    }
    return body.auth;
}

/** Session-authed reconcile fetch: `GET /api/v1/user/issue-watch` (cookies via the
 *  injected session fetch). Returns the per-workspace deltas the caller applies. */
async function defaultFetchUserSnapshot(
    tynnApiBaseUrl: string,
    fetchImpl: typeof fetch,
): Promise<IssueWatchDeltaPush[]> {
    const base = tynnApiBaseUrl.replace(/\/+$/, '');
    const url = `${base}/api/v1/user/issue-watch`;
    const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`user issue-watch reconcile HTTP ${res.status}`);
    return parseIssueWatchSnapshot(await res.json());
}

/**
 * Stand up the user-channel IssueWatch client. Returns a handle (to stop the
 * subscription) or null when it did NOT start — no signed-in user or no broadcast
 * config resolved. Best-effort: any failure logs and returns null rather than
 * throwing, so a boot never breaks and the workstation path is unaffected.
 */
export async function startUserChannelIssueWatch(
    deps: StartUserChannelIssueWatchDeps = {},
): Promise<UserChannelIssueWatchHandle | null> {
    const log = deps.log ?? (() => {});
    const backend = deps.backend ?? new TynnBackend();
    const fetchImpl = deps.fetchImpl ?? fetch;

    try {
        // 1) Who is signed in? No user → nothing to subscribe to.
        const user = await (deps.whoami ?? (() => backend.whoami()))();
        if (!user?.id) {
            log('no signed-in user — user-channel IssueWatch off');
            return null;
        }
        const channel = userChannel(user.id);
        const tynnApiBaseUrl = (deps.tynnApiBaseUrl ?? (() => backend.host()))();

        // 2) The (public) Pusher app key + cluster — env override → Tynn.
        const cfg = await (deps.broadcastConfig ??
            (() =>
                resolveBroadcastConfig({
                    env: process.env,
                    fromTynn: () => backend.fetchBroadcastConfig(),
                })))();
        if (!cfg) {
            log('no Pusher broadcast config resolved — user-channel IssueWatch off');
            return null;
        }

        // 3) One persistent subscription to the user's personal channel, authorized
        //    with the desktop's Tynn session cookie.
        const authorize = (socketId: string) =>
            authorizeUserChannel(socketId, channel, tynnApiBaseUrl, fetchImpl);
        const transport: WorkstationTransportLike = deps.makeTransport
            ? deps.makeTransport({ appKey: cfg.appKey, cluster: cfg.cluster, channel, authorize, tynnApiBaseUrl })
            : new WorkstationPusherTransport({
                  appKey: cfg.appKey,
                  cluster: cfg.cluster,
                  channel,
                  authorize,
                  tynnApiBaseUrl,
                  fetchImpl,
                  log,
              });

        const fetchSnapshot = deps.fetchSnapshot ?? ((base: string) => defaultFetchUserSnapshot(base, fetchImpl));
        const applyDelta =
            deps.applyDelta ?? ((d: IssueWatchDeltaPush) => applyPushedDelta(d as unknown as PushedIssueWatchDelta));

        const handle = transport.open({
            // On every (re)connect: reconcile the full user-scoped snapshot so a
            // workspace whose delta pushed while we were offline is caught up.
            onConnected: () => {
                void (async () => {
                    try {
                        const deltas = await fetchSnapshot(tynnApiBaseUrl);
                        for (const d of deltas) applyDelta(d);
                        log(`reconciled ${deltas.length} user IssueWatch snapshot(s)`);
                    } catch (e) {
                        log(`user issue-watch reconcile failed: ${errMsg(e)}`);
                    }
                })();
            },
            // Each live push: feed the issue-watch store (it stores + rebroadcasts).
            onIssueWatchDelta: (delta) => {
                try {
                    applyDelta(delta);
                } catch (e) {
                    log(`applyPushedDelta failed: ${errMsg(e)}`);
                }
            },
        });

        log(`subscribed to ${channel}`);
        return { userId: user.id, stop: () => handle.close() };
    } catch (e) {
        log(`startUserChannelIssueWatch failed: ${errMsg(e)}`);
        return null;
    }
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
