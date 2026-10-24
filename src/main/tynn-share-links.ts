/**
 * SHARING THROUGH TYNN (Tynn #839) — Genie 1's `main/tynn/workspace-share-links.ts` + `share-link-options.ts`, over this
 * Genie's Tynn session.
 *
 * A link is made in Tynn for ONE workspace of this machine or the whole workstation, control or read-only, for 1-30
 * days (a week by default). Its URL is the credential: Tynn serves it once, in the answer to its making, and the list
 * never carries it. Whoever opens it is entitled by Tynn and reaches this machine over the Tynn relay, scoped as the
 * link says (main/relay-grant.ts principalOf). A link can be revoked.
 */

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
    };
}

async function refusal(res: { status: number; json(): Promise<unknown> }, what: string): Promise<string> {
    if (res.status === 401 || res.status === 404 || res.status === 419) return `Tynn did not let this Genie ${what}: sign in to Tynn`;
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return typeof body?.message === 'string' && body.message !== '' ? body.message : `Tynn refused to ${what} (${res.status})`;
}

const reach = (error: unknown) => `Tynn could not be reached (${error instanceof Error ? error.message : String(error)})`;
const linksPath = (workstationId: string) => `/api/v1/workstations/${encodeURIComponent(workstationId)}/share-links`;

/** `workspaceId: null` = the whole workstation (`all_workspaces`, never with a list). */
export async function mintShareLink(
    request: SessionRequest,
    workstationId: string | null,
    input: { workspaceId: string | null; capability: 'control' | 'readonly'; expiresInDays: number },
): Promise<{ ok: true; link: ShareLink } | { ok: false; reason: string }> {
    if (!workstationId) return { ok: false, reason: NOT_REGISTERED };
    const scope = input.workspaceId === null ? { all_workspaces: true } : { workspace: input.workspaceId };
    try {
        const res = await request(linksPath(workstationId), { method: 'POST', body: { ...scope, capability: input.capability, expires_in_days: normalizeExpiryDays(input.expiresInDays) } });
        if (!res.ok) return { ok: false, reason: await refusal(res, 'make a share link') };
        const link = linkFrom(((await res.json().catch(() => null)) as { link?: unknown } | null)?.link);
        return link ? { ok: true, link } : { ok: false, reason: 'Tynn answered without the link' };
    } catch (error) {
        return { ok: false, reason: reach(error) };
    }
}

/** The links that reach this workspace — its own and whole-workstation ones — or, for `null`, every link. */
export async function listShareLinks(request: SessionRequest, workstationId: string | null, workspaceId: string | null): Promise<{ ok: true; links: ShareLink[] } | { ok: false; reason: string }> {
    if (!workstationId) return { ok: false, reason: NOT_REGISTERED };
    try {
        const res = await request(linksPath(workstationId), { method: 'GET' });
        if (!res.ok) return { ok: false, reason: await refusal(res, 'list share links') };
        const rows = ((await res.json().catch(() => null)) as { links?: unknown } | null)?.links;
        const links = (Array.isArray(rows) ? rows : []).map(linkFrom).filter((l): l is ShareLink => l !== null)
            // The list never serves a URL, whatever comes back.
            .map((l) => ({ ...l, url: null }));
        return { ok: true, links: workspaceId === null ? links : links.filter((l) => l.whole || l.workspaceIds.includes(workspaceId)) };
    } catch (error) {
        return { ok: false, reason: reach(error) };
    }
}

export async function revokeShareLink(request: SessionRequest, workstationId: string | null, linkId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!workstationId) return { ok: false, reason: NOT_REGISTERED };
    try {
        const res = await request(`${linksPath(workstationId)}/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
        return res.ok ? { ok: true } : { ok: false, reason: await refusal(res, 'revoke that link') };
    } catch (error) {
        return { ok: false, reason: reach(error) };
    }
}
