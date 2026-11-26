/**
 * SHARING THROUGH TYNN (Tynn #839) — Genie 1's `main/tynn/workspace-share-links.ts` + `share-link-options.ts`, over this
 * Genie's Tynn session.
 *
 * A link is made in Tynn for ONE workspace of this machine or the whole workstation, control or read-only, for 1-30
 * days (a week by default). Its URL is the credential: Tynn serves it once, in the answer to its making, and the list
 * never carries it. Whoever opens it is entitled by Tynn and reaches this machine over the Tynn relay, scoped as the
 * link says (main/relay-grant.ts principalOf). A link can be revoked.
 */

import type { WorkstationRole } from '../core/workstation-role.js';

type SessionRequest = (path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ShareLink {
    readonly id: string;
    /** Only on the answer to its making; `null` in the list. */
    readonly url: string | null;
    readonly capability: 'control' | 'readonly';
    /** Reaches the whole workstation. */
    readonly whole: boolean;
    readonly workspaceIds: readonly string[];
    readonly expiresAt: string | null;
    /** Someone has redeemed it and its one session can still be used (tynn.ai #394): revoking it ends that session. */
    readonly claimed: boolean;
}

export const NOT_REGISTERED = 'This machine is not registered with Tynn yet, so there is nothing to share it on: sign in to Tynn in Genie and it registers itself';

export const SHARE_LINK_EXPIRY_CHOICES = [1, 7, 14, 30] as const;
const DEFAULT_DAYS = 7;

/** 1-30 whole days; anything else is the default week. */
export function normalizeExpiryDays(raw: unknown): number {
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 30 ? raw : DEFAULT_DAYS;
}

function linkFrom(raw: unknown): ShareLink | null {
    if (!raw || typeof raw !== 'object') return null;
    const l = raw as Record<string, unknown>;
    if (typeof l.id !== 'string') return null;
    return {
        id: l.id,
        url: typeof l.url === 'string' && l.url !== '' ? l.url : null,
        capability: l.capability === 'readonly' ? 'readonly' : 'control',
        whole: l.all_workspaces === true,
        workspaceIds: Array.isArray(l.workspace_ids) ? l.workspace_ids.filter((w): w is string => typeof w === 'string') : [],
        expiresAt: typeof l.expires_at === 'string' ? l.expires_at : null,
        claimed: l.claimed === true,
    };
}

/** A refusal; `refusedByTynn` = Tynn's 404 (it answers every refusal so, signed out or not allowed), for shareLinksOver to word. */
export type ShareRefusal = { ok: false; reason: string; refusedByTynn?: true };

async function refusal(res: { status: number; json(): Promise<unknown> }, what: string): Promise<ShareRefusal> {
    if (res.status === 401 || res.status === 404 || res.status === 419) return { ok: false, reason: `Tynn did not let this Genie ${what}: sign in to Tynn`, refusedByTynn: true };
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return { ok: false, reason: typeof body?.message === 'string' && body.message !== '' ? body.message : `Tynn refused to ${what} (${res.status})` };
}

/**
 * WHAT A DRONE IS TOLD WHEN TYNN REFUSES ITS SHARE LINKS (Tynn #963): signed in, so "sign in to Tynn" was untrue. Tynn has
 * this machine as a drone and refuses a drone's share links; that is Tynn's rule, not this person's sign-in.
 */
export const DRONE_SHARE_REFUSAL = 'Tynn has this workstation as a drone and refused its share links. You are signed in, so signing in again will not change this';

const reach = (error: unknown) => `Tynn could not be reached (${error instanceof Error ? error.message : String(error)})`;
const linksPath = (workstationId: string) => `/api/v1/workstations/${encodeURIComponent(workstationId)}/share-links`;

/** `workspaceId: null` = the whole workstation (`all_workspaces`, never with a list). */
export async function mintShareLink(
    request: SessionRequest,
    workstationId: string | null,
    input: { workspaceId: string | null; capability: 'control' | 'readonly'; expiresInDays: number },
): Promise<{ ok: true; link: ShareLink } | ShareRefusal> {
    if (!workstationId) return { ok: false, reason: NOT_REGISTERED };
    const scope = input.workspaceId === null ? { all_workspaces: true } : { workspace: input.workspaceId };
    try {
        const res = await request(linksPath(workstationId), { method: 'POST', body: { ...scope, capability: input.capability, expires_in_days: normalizeExpiryDays(input.expiresInDays) } });
        if (!res.ok) return await refusal(res, 'make a share link');
        const link = linkFrom(((await res.json().catch(() => null)) as { link?: unknown } | null)?.link);
        return link ? { ok: true, link } : { ok: false, reason: 'Tynn answered without the link' };
    } catch (error) {
        return { ok: false, reason: reach(error) };
    }
}

/** The links that reach this workspace — its own and whole-workstation ones — or, for `null`, every link. */
export async function listShareLinks(request: SessionRequest, workstationId: string | null, workspaceId: string | null): Promise<{ ok: true; links: ShareLink[] } | ShareRefusal> {
    if (!workstationId) return { ok: false, reason: NOT_REGISTERED };
    try {
        const res = await request(linksPath(workstationId), { method: 'GET' });
        if (!res.ok) return await refusal(res, 'list share links');
        const rows = ((await res.json().catch(() => null)) as { links?: unknown } | null)?.links;
        const links = (Array.isArray(rows) ? rows : []).map(linkFrom).filter((l): l is ShareLink => l !== null)
            // The list never serves a URL, whatever comes back.
            .map((l) => ({ ...l, url: null }));
        return { ok: true, links: workspaceId === null ? links : links.filter((l) => l.whole || l.workspaceIds.includes(workspaceId)) };
    } catch (error) {
        return { ok: false, reason: reach(error) };
    }
}

/**
 * Revoke a link. Tynn deletes it and revokes the grants its claimed session holds (tynn.ai #394); `endSessions` then has
 * this host re-check its live relay sessions at once, so a guest on that link is dropped now, not at the next 30-second
 * introspection (audit M-c). A re-check that fails does not undo the revoke: the timer still catches the session.
 */
export async function revokeShareLink(
    request: SessionRequest,
    workstationId: string | null,
    linkId: string,
    endSessions?: () => Promise<void>,
): Promise<{ ok: true } | ShareRefusal> {
    if (!workstationId) return { ok: false, reason: NOT_REGISTERED };
    let res: Awaited<ReturnType<SessionRequest>>;
    try {
        res = await request(`${linksPath(workstationId)}/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
    } catch (error) {
        return { ok: false, reason: reach(error) };
    }
    if (!res.ok) return refusal(res, 'revoke that link');
    if (endSessions) {
        try { await endSessions(); } catch { /* the revoke stands; the host's own 30 s re-check still ends the session */ }
    }
    return { ok: true };
}

/**
 * A HOST'S SHARE LINKS, over its Tynn session (Tynn #898 step 2d-2b): genie-host answers them for every remote client, as
 * a window did. The workstation is read at each call (it registers after start); `endSessions` re-checks the relay's
 * live sessions after a revoke.
 */
export function shareLinksOver(ports: { request: SessionRequest; workstation: () => string | null; endSessions?: () => Promise<void>; rereadRole?: () => Promise<WorkstationRole | null> }) {
    // Tynn's 404, worded from the role read again (Tynn #963): a drone's share links of ANOTHER machine stay refused; only {ok, reason} leaves.
    const worded = async <R extends { ok: true }>(pending: Promise<R | ShareRefusal>): Promise<R | { ok: false; reason: string }> => {
        const r = await pending;
        if (r.ok) return r;
        if (r.refusedByTynn && ports.rereadRole && (await ports.rereadRole().catch(() => null)) === 'drone') return { ok: false, reason: DRONE_SHARE_REFUSAL };
        return { ok: false, reason: r.reason };
    };
    return {
        list: (workspaceId: string | null) => worded(listShareLinks(ports.request, ports.workstation(), workspaceId)),
        mint: (input: { workspaceId: string | null; capability: 'control' | 'readonly'; expiresInDays: number }) => worded(mintShareLink(ports.request, ports.workstation(), input)),
        revoke: (linkId: string) => worded(revokeShareLink(ports.request, ports.workstation(), linkId, ports.endSessions)),
    };
}
