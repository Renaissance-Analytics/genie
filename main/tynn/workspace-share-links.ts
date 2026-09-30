import { TynnBackend, type WorkspaceShareLink } from '../backend/tynn';
import { readWorkstationIdentity } from './workstation-identity';

/**
 * SHARE ONE WORKSPACE BY LINK — the layer between the IPC handlers and Tynn.
 *
 * The owner's ask: "individual workspaces from Genie that I can share to a user
 * by giving them a link that opens a Genie window to that workspace." Tynn is the
 * service (it mints the invite, binds the first redeemer, and hosts the redemption
 * page); this is the part that only Genie can answer — WHICH workstation this
 * machine is.
 *
 * That is the whole reason this module exists rather than the panel calling the
 * backend directly. A share link is scoped to a workspace ON a workstation, and
 * before Genie has self-registered with Tynn there is no workstation to scope to.
 * An unenrolled machine has to produce a sentence the user can act on, not an
 * exception inside the settings modal.
 */
export interface ShareLinkBackend {
    mintWorkspaceShareLink(
        workstationId: string,
        workspaceId: string,
        capability: 'control' | 'readonly',
    ): Promise<WorkspaceShareLink>;
    listWorkspaceShareLinks(
        workstationId: string,
        workspaceId: string,
    ): Promise<WorkspaceShareLink[]>;
    revokeWorkspaceShareLink(workstationId: string, linkId: string): Promise<void>;
}

export interface ShareLinkDeps {
    identity: () => { workstationId: string } | null;
    backend: ShareLinkBackend;
}

export type MintResult = { ok: true; link: WorkspaceShareLink } | { ok: false; error: string };

const NOT_ENROLLED =
    'This computer is not registered with Tynn yet, so there is nothing to share a ' +
    'workspace on. Sign in to Tynn in Genie and it registers automatically.';

function defaults(): ShareLinkDeps {
    return {
        identity: () => {
            const id = readWorkstationIdentity();
            return id ? { workstationId: id.workstationId } : null;
        },
        backend: new TynnBackend(),
    };
}

/**
 * Mint a link for one workspace. Never throws — the caller is a click handler in
 * the settings modal, and the failure it most needs to report (Tynn refused) is
 * carried in `error` so the panel can print the service's own words. A generic
 * "something went wrong" would send the user looking in the wrong place.
 */
export async function mintWorkspaceShareLink(
    workspaceId: string,
    capability: 'control' | 'readonly',
    deps: ShareLinkDeps = defaults(),
): Promise<MintResult> {
    const identity = deps.identity();
    if (!identity) return { ok: false, error: NOT_ENROLLED };

    try {
        const link = await deps.backend.mintWorkspaceShareLink(
            identity.workstationId,
            workspaceId,
            capability,
        );
        return { ok: true, link };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * The live links for one workspace, for the link manager. Empty on any failure —
 * including an unenrolled machine, which never reaches Tynn at all. The panel
 * distinguishes "no links" from "cannot ask" by checking enrollment separately;
 * this list is only ever the answer to "what is live right now".
 */
export async function listWorkspaceShareLinks(
    workspaceId: string,
    deps: ShareLinkDeps = defaults(),
): Promise<WorkspaceShareLink[]> {
    const identity = deps.identity();
    if (!identity) return [];

    try {
        return await deps.backend.listWorkspaceShareLinks(identity.workstationId, workspaceId);
    } catch {
        return [];
    }
}

/**
 * Invalidate one link. Reports failure truthfully: the one thing this surface must
 * never do is show a link as revoked while it is still live, which is exactly what
 * swallowing the error would produce.
 */
export async function revokeWorkspaceShareLink(
    linkId: string,
    deps: ShareLinkDeps = defaults(),
): Promise<{ ok: boolean; error?: string }> {
    const identity = deps.identity();
    if (!identity) return { ok: false, error: NOT_ENROLLED };

    try {
        await deps.backend.revokeWorkspaceShareLink(identity.workstationId, linkId);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/** Whether this machine can share at all — what the panel shows instead of a form. */
export function shareLinkAvailability(
    deps: ShareLinkDeps = defaults(),
): { enrolled: true } | { enrolled: false; reason: string } {
    return deps.identity() ? { enrolled: true } : { enrolled: false, reason: NOT_ENROLLED };
}
