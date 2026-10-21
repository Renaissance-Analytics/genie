import type { ServerTransport } from '../core/remote-protocol.js';
import { verifyMemberGrant, type GrantCheck, type TynnJwk } from './relay-grant.js';
import { relayHostLink, type RelayHostLinkDeps } from './relay-host.js';
import { buildTicketHostHello, type PopJwk, type RelaySocketFactory } from './relay-wire.js';

/**
 * THE TYNN NETWORK, WIRED (Tynn #837 + #838) — the Tynn calls behind the relay's two ends, as Genie 1 made them
 * (`v1:main/backend/tynn.ts` connectable / connectGrant, `host-core/relay-host/service.ts`).
 *
 * A MEMBER asks over the signed-in session: which workstations this person may reach, and a grant for one, bound to
 * this connection's proof key. A HOST asks with its own proof (`Authorization: Workstation …`, never the session): a
 * relay ticket and the relay to dial, Tynn's grant keys, and whether a grant is still active.
 */

type SessionRequest = (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A workstation Tynn says this person can see — reachable (`connectable`) or not. */
export interface TynnWorkstation {
    readonly id: string;
    readonly name: string;
    readonly active: boolean;
    /** Active AND this person is entitled to it. */
    readonly connectable: boolean;
    /** A desktop (rides the shared relay) rather than a cloud box. */
    readonly local: boolean;
    /** owner | grant | invite; `null` when not entitled. */
    readonly source: string | null;
}

export type TynnWorkstations = { readonly ok: true; readonly workstations: readonly TynnWorkstation[] } | { readonly ok: false; readonly reason: string };

const signedOut = (status: number) => status === 401 || status === 404 || status === 419;

async function tynnSays(res: { status: number; json(): Promise<unknown> }, fallback: string): Promise<string> {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return typeof body?.message === 'string' && body.message !== '' ? body.message : `${fallback} (${res.status})`;
}

/** `GET /workstations/connectable`, never this machine itself, each once. */
export async function connectableWorkstations(request: SessionRequest, ownWorkstationId: string | null): Promise<TynnWorkstations> {
    let res: Awaited<ReturnType<SessionRequest>>;
    try {
        res = await request('/workstations/connectable', { method: 'GET' });
    } catch (error) {
        return { ok: false, reason: `Tynn could not be reached (${error instanceof Error ? error.message : String(error)})` };
    }
    if (signedOut(res.status)) return { ok: false, reason: 'sign in to Tynn to see your workstations' };
    if (!res.ok) return { ok: false, reason: await tynnSays(res, 'Tynn did not list your workstations') };
    const rows = ((await res.json().catch(() => null)) as { workstations?: unknown } | null)?.workstations;
    const byId = new Map<string, TynnWorkstation>();
    for (const row of Array.isArray(rows) ? rows : []) {
        const r = row as Record<string, unknown>;
        if (typeof r.id !== 'string' || r.id === ownWorkstationId || byId.has(r.id)) continue;
        byId.set(r.id, {
            id: r.id,
            name: typeof r.name === 'string' && r.name !== '' ? r.name : r.id,
            active: r.status === 'active',
            connectable: r.connectable === true,
            local: r.is_local === true,
            source: typeof r.source === 'string' ? r.source : null,
        });
    }
    return { ok: true, workstations: [...byId.values()] };
}

/** `POST /workstations/{id}/connect-grant {pop_jwk}`: the grant and the relay to dial. */
export async function mintConnectGrant(request: SessionRequest, workstationId: string, popJwk: PopJwk): Promise<{ ok: true; token: string; relayEndpoint: string } | { ok: false; reason: string }> {
    let res: Awaited<ReturnType<SessionRequest>>;
    try {
        res = await request(`/workstations/${encodeURIComponent(workstationId)}/connect-grant`, { method: 'POST', body: { pop_jwk: popJwk } });
    } catch (error) {
        return { ok: false, reason: `Tynn could not be reached (${error instanceof Error ? error.message : String(error)})` };
    }
    // Since tynn.ai#303 an unauthenticated OR unentitled request is one 404: Tynn no longer says which.
    if (signedOut(res.status)) return { ok: false, reason: 'Tynn did not give this machine a way in: sign in to Tynn, and check the workstation is shared with you' };
    if (!res.ok) return { ok: false, reason: await tynnSays(res, 'Tynn refused a connection') };
    const body = (await res.json().catch(() => null)) as { token?: unknown; relay_endpoint?: unknown } | null;
    if (typeof body?.token !== 'string' || typeof body.relay_endpoint !== 'string' || body.relay_endpoint === '') return { ok: false, reason: 'Tynn answered without a grant and a relay' };
    return { ok: true, token: body.token, relayEndpoint: body.relay_endpoint };
}

export interface RelayHostPorts {
    ticket(): Promise<{ ticket: string; relayEndpoint: string }>;
    keys(): Promise<TynnJwk[]>;
    introspect(token: string): Promise<boolean>;
}

/** The host's own calls to Tynn: its proof header, no session, no cookies. */
export function relayHostPorts(input: { tynnHost: string; workstationId: string; authHeader: () => string; fetch: typeof fetch }): RelayHostPorts {
    const base = input.tynnHost.replace(/\/+$/, '');
    return {
        async ticket() {
            let res: Response;
            try {
                res = await input.fetch(`${base}/api/v1/workstations/${encodeURIComponent(input.workstationId)}/relay-ticket`, { method: 'POST', headers: { accept: 'application/json', authorization: input.authHeader() } });
            } catch (error) {
                throw new Error(`Tynn could not be reached (${error instanceof Error ? error.message : String(error)})`);
            }
            const body = (await res.json().catch(() => ({}))) as { ticket?: unknown; relay_endpoint?: unknown; message?: unknown };
            if (!res.ok || typeof body.ticket !== 'string' || typeof body.relay_endpoint !== 'string') {
                throw new Error(typeof body.message === 'string' && body.message !== '' ? body.message : `Tynn refused a relay ticket (${res.status})`);
            }
            return { ticket: body.ticket, relayEndpoint: body.relay_endpoint };
        },
        async keys() {
            const res = await input.fetch(`${base}/api/v1/workstations/grants/public-keys`, { headers: { accept: 'application/json' } });
            const body = (await res.json()) as { keys?: unknown };
            return Array.isArray(body.keys) ? (body.keys as TynnJwk[]) : [];
        },
        async introspect(token) {
            try {
                const res = await input.fetch(`${base}/api/v1/workstations/grants/introspect`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ token }) });
                return ((await res.json()) as { active?: unknown }).active === true;
            } catch {
                return false; // cannot confirm it is still good → not active
            }
        },
    };
}

/** Tynn's signature first (keys fetched again once for a new key id), then still active — a forged grant never asks. */
export function grantValidator(input: { workstationId: string; keys: () => Promise<TynnJwk[]>; introspect: (token: string) => Promise<boolean> }): (token: string) => Promise<GrantCheck> {
    let keys: TynnJwk[] | null = null;
    const refresh = async () => { keys = await input.keys().catch(() => keys ?? []); };
    return async (token) => {
        if (keys === null) await refresh();
        let check = verifyMemberGrant(token, { keys: keys ?? [], workstationId: input.workstationId });
        if (!check.ok && check.reason === 'unknown signing key') {
            await refresh();
            check = verifyMemberGrant(token, { keys: keys ?? [], workstationId: input.workstationId });
        }
        if (!check.ok) return check;
        return (await input.introspect(token)) ? check : { ok: false, reason: 'grant is no longer active' };
    };
}

export type RelayHostStatus =
    | { readonly state: 'off' }
    | { readonly state: 'connecting' }
    | { readonly state: 'reachable'; readonly relay: string }
    | { readonly state: 'unavailable'; readonly reason: string };

export interface RelayHostHandle {
    status(): RelayHostStatus;
    stop(): void;
}

/**
 * This Genie reachable over the Tynn relay: the first ticket names the relay; the link dials it with that ticket and
 * asks for a fresh one on every redial. The link is handed to `attach` (RemoteHost's transports) while it lives.
 */
export function startRelayHost(input: {
    ports: RelayHostPorts;
    socket: RelaySocketFactory;
    workstationId: string;
    fingerprint: string;
    sign: (data: Buffer) => Buffer;
    attach?: (transport: ServerTransport) => () => void;
    onStatus?: (status: RelayHostStatus) => void;
    reconnect?: { minMs: number; maxMs: number };
    log?: (message: string) => void;
    /** This host's `.gen` sites for the owner's windows elsewhere (relay-site.ts `dialFrontDoor`). */
    site?: RelayHostLinkDeps['site'];
}): RelayHostHandle {
    let status: RelayHostStatus = { state: 'connecting' };
    let stopped = false;
    let link: ReturnType<typeof relayHostLink> | null = null;
    let detach: (() => void) | null = null;
    const set = (next: RelayHostStatus) => {
        status = next;
        input.onStatus?.(next);
    };
    set({ state: 'connecting' });

    void (async () => {
        let first: { ticket: string; relayEndpoint: string };
        try {
            first = await input.ports.ticket();
        } catch (error) {
            if (!stopped) set({ state: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
            return;
        }
        if (stopped) return;
        let pending: { ticket: string } | null = first;
        const relay = first.relayEndpoint;
        link = relayHostLink({
            socket: input.socket,
            relayUrl: relay,
            workstationId: input.workstationId,
            // The first dial uses the ticket already fetched; every redial asks Tynn again.
            hello: async () => {
                const t = pending ?? (await input.ports.ticket());
                pending = null;
                return buildTicketHostHello({ ticket: t.ticket, workstationId: input.workstationId, fingerprint: input.fingerprint, sign: input.sign });
            },
            validateGrant: grantValidator({ workstationId: input.workstationId, keys: () => input.ports.keys(), introspect: (t) => input.ports.introspect(t) }),
            ...(input.reconnect ? { reconnect: input.reconnect } : {}),
            ...(input.site ? { site: input.site } : {}),
            onState: (state, detail) => {
                if (stopped) return;
                if (state === 'open') set({ state: 'reachable', relay });
                else if (state === 'closed' && detail) set({ state: 'unavailable', reason: detail });
                else if (state === 'connecting' && status.state !== 'unavailable') set({ state: 'connecting' });
            },
            ...(input.log ? { log: input.log } : {}),
        });
        detach = input.attach?.(link) ?? null;
        link.connect();
    })();

    return {
        status: () => status,
        stop() {
            stopped = true;
            link?.close();
            detach?.();
            detach = null;
            set({ state: 'off' });
        },
    };
}
