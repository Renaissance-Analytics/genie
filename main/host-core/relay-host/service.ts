import { mintGuestSession, mintRelayOwnerSession } from '../../mobile/auth';
import { endRelaySession, onGuestDisconnected } from '../../mobile/server';
import { NOT_LISTENING_MESSAGE } from '../../tynn/relay-host-controller';
import { grantAccessPolicy, verifyMemberGrant, type HostGrant, type TynnJwk } from './grant';
import { buildTicketHostHello } from './hello';
import { RelayHostLink, type RelayLinkState } from './link';
import { createLoopbackProxy } from './loopback-proxy';

/**
 * This machine as a RELAY HOST (genie#680): reachable over Tynn, with no inbound
 * port and no shared network — the thing the Settings "Tynn" network switch has
 * been describing (genie#451).
 *
 * It asks Tynn for a relay ticket (host-authed with the enrolled key) and the relay
 * to dial, dials it, and for every member session: verifies the grant against
 * Tynn's published keys and introspection, mints that member their own session on
 * the local server from the grant (a guest judged by its scope; or, for the owner's
 * own grant, the owner), and proxies their frames onto 127.0.0.1. A grant that
 * stops introspecting ends its session and closes its sockets.
 *
 * Every dependency is injected, so the whole path runs in a test against a real
 * relay socket, the real local server and Genie's real member client.
 */

export type RelayHostStatus =
    | { state: 'connecting' }
    | { state: 'connected'; relay: string }
    /** Cannot be reached, and why: `no_relay`, `workstation_not_active`, `tynn_error`, `not_listening`. */
    | { state: 'unavailable'; reason: string; message: string }
    | { state: 'stopped' };

export interface RelayHostDeps {
    workstationId: string;
    fingerprint: string;
    /** Sign with the enrolled host key. */
    sign: (data: Buffer) => Buffer;
    /** The `Authorization: Workstation <ts>:<sig>` host proof for Tynn. */
    authHeader: () => string;
    tynnApiBaseUrl: string;
    /** The local member-facing server on loopback, or null when it is not listening. */
    localBaseUrl: () => string | null;
    fetchImpl?: typeof fetch;
    /** Re-introspect live sessions this often (ms). Default 30s; 0 disables. */
    revalidateMs?: number;
    reconnect?: { minMs: number; maxMs: number };
    onStatus?: (status: RelayHostStatus) => void;
    log?: (msg: string) => void;
}

export interface RelayHostHandle {
    status(): RelayHostStatus;
    stop(): void;
}

class TynnRefusal extends Error {
    constructor(
        readonly reason: string,
        message: string,
    ) {
        super(message);
    }
}

export function startRelayHost(deps: RelayHostDeps): RelayHostHandle {
    const doFetch = deps.fetchImpl ?? fetch;
    const base = deps.tynnApiBaseUrl.replace(/\/+$/, '');
    const log = deps.log ?? (() => {});
    let status: RelayHostStatus = { state: 'connecting' };
    let keys: TynnJwk[] = [];
    let link: RelayHostLink | null = null;
    let relayUrl: string | null = null;
    let stopped = false;
    const tokens = new Map<string, string>();

    const setStatus = (next: RelayHostStatus) => {
        status = next;
        deps.onStatus?.(next);
    };

    async function ticket(): Promise<{ ticket: string; relay_endpoint: string }> {
        let res: Response;
        try {
            res = await doFetch(`${base}/api/v1/workstations/${encodeURIComponent(deps.workstationId)}/relay-ticket`, {
                method: 'POST',
                headers: { accept: 'application/json', authorization: deps.authHeader() },
            });
        } catch (e) {
            throw new TynnRefusal('tynn_error', `Could not reach Tynn: ${e instanceof Error ? e.message : String(e)}`);
        }
        const body = (await res.json().catch(() => ({}))) as { ticket?: string; relay_endpoint?: string; error?: string; message?: string };
        if (!res.ok || !body.ticket || !body.relay_endpoint) {
            throw new TynnRefusal(body.error ?? 'tynn_error', body.message ?? `Tynn refused a relay ticket (HTTP ${res.status}).`);
        }
        return { ticket: body.ticket, relay_endpoint: body.relay_endpoint };
    }

    async function refreshKeys(): Promise<void> {
        const res = await doFetch(`${base}/api/v1/workstations/grants/public-keys`, { headers: { accept: 'application/json' } });
        const body = (await res.json()) as { keys?: TynnJwk[] };
        if (Array.isArray(body.keys)) keys = body.keys;
    }

    async function introspect(token: string): Promise<boolean> {
        try {
            const res = await doFetch(`${base}/api/v1/workstations/grants/introspect`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ token }),
            });
            const body = (await res.json()) as { active?: boolean };
            return body.active === true;
        } catch {
            return false; // cannot confirm the grant is still good → fail closed
        }
    }

    async function validateGrant(token: string) {
        let check = verifyMemberGrant(token, { keys, workstationId: deps.workstationId });
        if (!check.ok && check.reason === 'unknown signing key') {
            await refreshKeys().catch(() => {});
            check = verifyMemberGrant(token, { keys, workstationId: deps.workstationId });
        }
        if (!check.ok) return check;
        return (await introspect(token)) ? check : ({ ok: false, reason: 'grant is no longer active' } as const);
    }

    function openSession(sid: string, grant: HostGrant): boolean {
        if (!deps.localBaseUrl()) return false;
        const name = grant.name ?? grant.sub;
        const session =
            grant.source === 'owner'
                ? mintRelayOwnerSession({ userId: grant.sub, name })
                : mintGuestSession({ policy: grantAccessPolicy(grant), name });
        tokens.set(sid, session.token);
        return true;
    }

    // The loopback proxy talks to THIS machine's server, never to Tynn: it gets the
    // platform fetch, not the injected Tynn one.
    const proxy = createLoopbackProxy({
        baseUrl: () => deps.localBaseUrl(),
        tokenFor: (sid) => tokens.get(sid) ?? null,
    });

    function closeSession(sid: string): void {
        proxy.closeSession(sid);
        const token = tokens.get(sid);
        tokens.delete(sid);
        if (token) endRelaySession(token);
    }

    // The host disconnected a guest from its banner: end their relay sessions too,
    // so the member is told, rather than left connected to a revoked session.
    const stopListening = onGuestDisconnected((principalId) => {
        for (const { sid, grant } of link?.admittedSessions() ?? []) {
            if (grant.source !== 'owner' && grant.sub === principalId) link?.endSession(sid, 'disconnected by the host');
        }
    });

    function onLinkState(state: RelayLinkState, detail?: string): void {
        if (stopped) return;
        if (state === 'open' && relayUrl) setStatus({ state: 'connected', relay: relayUrl });
        else if (state === 'connecting' || state === 'authenticating') {
            if (status.state !== 'unavailable') setStatus({ state: 'connecting' });
        } else if (state === 'closed' && detail === undefined && status.state === 'connected') {
            setStatus({ state: 'connecting' });
        }
    }

    void (async () => {
        setStatus({ state: 'connecting' });
        if (!deps.localBaseUrl()) {
            setStatus({ state: 'unavailable', reason: 'not_listening', message: NOT_LISTENING_MESSAGE });
            return;
        }
        let first: { ticket: string; relay_endpoint: string };
        try {
            [first] = await Promise.all([ticket(), refreshKeys()]);
        } catch (e) {
            const refusal = e instanceof TynnRefusal ? e : new TynnRefusal('tynn_error', e instanceof Error ? e.message : String(e));
            log(`relay host unavailable: ${refusal.reason} — ${refusal.message}`);
            setStatus({ state: 'unavailable', reason: refusal.reason, message: refusal.message });
            return;
        }
        if (stopped) return;
        relayUrl = first.relay_endpoint;
        let pending: { ticket: string } | null = first;
        link = new RelayHostLink({
            relayUrl: first.relay_endpoint,
            workstationId: deps.workstationId,
            sign: deps.sign,
            // The first dial uses the ticket already fetched; every re-dial asks again.
            hello: async () => {
                const t = pending ?? (await ticket());
                pending = null;
                return buildTicketHostHello({ ticket: t.ticket, workstationId: deps.workstationId, fingerprint: deps.fingerprint, sign: deps.sign });
            },
            validateGrant,
            onSessionOpen: openSession,
            onSessionClose: closeSession,
            onFrame: proxy.handle,
            onState: onLinkState,
            revalidateMs: deps.revalidateMs ?? 30_000,
            reconnect: deps.reconnect,
            log,
        });
        link.connect();
    })();

    return {
        status: () => status,
        stop() {
            stopped = true;
            stopListening();
            link?.close();
            for (const sid of [...tokens.keys()]) closeSession(sid);
            setStatus({ state: 'stopped' });
        },
    };
}
