import { describe, expect, it, vi } from 'vitest';
import {
    listWorkspaceShareLinks,
    mintWorkspaceShareLink,
    mintWorkstationShareLink,
    revokeWorkspaceShareLink,
    type ShareLinkDeps,
} from '../workspace-share-links';
import { DEFAULT_SHARE_LINK_EXPIRY_DAYS } from '../share-link-options';

/**
 * The share-link layer BETWEEN the IPC handlers and the Tynn client.
 *
 * It exists for one reason the client cannot cover: a share link is scoped to a
 * workspace ON A WORKSTATION, and Genie has to know which workstation THIS
 * machine is. When it is not enrolled there is no id to share under, and the
 * failure has to be a sentence the user can act on — not a crash in the settings
 * modal and not a silent empty list, which is indistinguishable from "no links".
 */
function deps(over: Partial<ShareLinkDeps> = {}): ShareLinkDeps {
    return {
        identity: () => ({ workstationId: 'wst-1' }),
        backend: {
            mintWorkspaceShareLink: vi.fn(async () => ({
                id: 'inv1',
                url: 'https://tynn.ai/invites/accept/tok',
                token: 'tok',
                capability: 'readonly' as const,
                workspace_ids: ['ws-design'],
                all_workspaces: false,
                expires_at: null,
                created_at: null,
            })),
            mintWorkstationShareLink: vi.fn(async () => ({
                id: 'inv2',
                url: 'https://tynn.ai/invites/accept/tok2',
                token: 'tok2',
                capability: 'control' as const,
                workspace_ids: ['ws-design', 'ws-payroll'],
                all_workspaces: false,
                expires_at: null,
                created_at: null,
            })),
            listWorkspaceShareLinks: vi.fn(async () => []),
            revokeWorkspaceShareLink: vi.fn(async () => {}),
        },
        ...over,
    };
}

describe('mintWorkspaceShareLink', () => {
    it('mints under THIS machine’s workstation id', async () => {
        const d = deps();
        const out = await mintWorkspaceShareLink('ws-design', { capability: 'readonly' }, d);

        expect(out.ok).toBe(true);
        expect(d.backend.mintWorkspaceShareLink).toHaveBeenCalledWith(
            'wst-1',
            'ws-design',
            'readonly',
            DEFAULT_SHARE_LINK_EXPIRY_DAYS,
        );
    });

    it('sends the expiry the user picked', async () => {
        // The owner asked for control over how long a link lives. Tynn has always
        // taken `expires_in_days`; Genie never sent one, so every link expired in
        // a week whatever the user wanted.
        const d = deps();
        await mintWorkspaceShareLink('ws-design', { capability: 'control', expiresInDays: 1 }, d);

        expect(d.backend.mintWorkspaceShareLink).toHaveBeenCalledWith(
            'wst-1',
            'ws-design',
            'control',
            1,
        );
    });

    it('refuses to forward an expiry Tynn would reject, and mints anyway', async () => {
        // This value crosses IPC, so main cannot take the renderer's word for it.
        // Forwarding 9000 is a 422 the user sees as "could not create link"; the
        // default is a link they can still use.
        const d = deps();
        const out = await mintWorkspaceShareLink(
            'ws-design',
            { capability: 'readonly', expiresInDays: 9000 },
            d,
        );

        expect(out.ok).toBe(true);
        expect(d.backend.mintWorkspaceShareLink).toHaveBeenCalledWith(
            'wst-1',
            'ws-design',
            'readonly',
            DEFAULT_SHARE_LINK_EXPIRY_DAYS,
        );
    });

    it('explains an unenrolled machine instead of crashing', async () => {
        // Genie only has a workstation id once it has self-registered with Tynn.
        // Before that there is nothing to share a workspace ON, and the user needs
        // to be told that — a thrown error here takes the settings modal with it.
        const out = await mintWorkspaceShareLink('ws-design', { capability: 'readonly' }, deps({ identity: () => null }));

        expect(out.ok).toBe(false);
        expect(out.ok === false && out.error).toMatch(/sign in|Tynn/i);
    });

    it('surfaces a refusal from Tynn as its message, not as a generic failure', async () => {
        // The service refuses a workspace this machine does not report yet (422).
        // "Something went wrong" would send the user looking in the wrong place.
        const d = deps({
            backend: {
                ...deps().backend,
                mintWorkspaceShareLink: vi.fn(async () => {
                    throw new Error('Tynn POST /share-links → 422 workspace not hosted');
                }),
            },
        });

        const out = await mintWorkspaceShareLink('ws-design', { capability: 'readonly' }, d);

        expect(out.ok).toBe(false);
        expect(out.ok === false && out.error).toContain('422');
    });
});

/**
 * A WORKSTATION link — the other half of the owner's sharing model.
 *
 * Same enrollment question as the workspace form (there is no workstation to
 * share until Genie has self-registered), and the same never-throws contract,
 * because the caller is still a click handler. What differs is the reach, and
 * the one rule worth pinning here is that the two ways of expressing it never
 * travel together.
 */
describe('mintWorkstationShareLink', () => {
    it('mints a link over the named workspaces', async () => {
        const d = deps();
        const out = await mintWorkstationShareLink(
            { workspaces: ['ws-design', 'ws-payroll'], capability: 'control' },
            d,
        );

        expect(out.ok).toBe(true);
        expect(d.backend.mintWorkstationShareLink).toHaveBeenCalledWith('wst-1', {
            workspaces: ['ws-design', 'ws-payroll'],
            capability: 'control',
            expiresInDays: DEFAULT_SHARE_LINK_EXPIRY_DAYS,
        });
    });

    it('mints a whole-machine link when asked for one', async () => {
        const d = deps();
        await mintWorkstationShareLink(
            { allWorkspaces: true, capability: 'readonly', expiresInDays: 1 },
            d,
        );

        expect(d.backend.mintWorkstationShareLink).toHaveBeenCalledWith('wst-1', {
            allWorkspaces: true,
            capability: 'readonly',
            expiresInDays: 1,
        });
    });

    it('refuses a link that reaches nothing, without asking Tynn', async () => {
        // The service refuses an empty list too, but a 422 reaches the user as
        // "could not create link". Said here, it is a sentence about what they
        // picked — and it costs no round trip.
        const d = deps();
        const out = await mintWorkstationShareLink({ workspaces: [], capability: 'control' }, d);

        expect(out.ok).toBe(false);
        expect(out.ok === false && out.error).toMatch(/workspace/i);
        expect(d.backend.mintWorkstationShareLink).not.toHaveBeenCalled();
    });

    it('normalises the expiry here too', async () => {
        const d = deps();
        await mintWorkstationShareLink(
            { allWorkspaces: true, capability: 'control', expiresInDays: 9000 },
            d,
        );

        expect(d.backend.mintWorkstationShareLink).toHaveBeenCalledWith(
            'wst-1',
            expect.objectContaining({ expiresInDays: DEFAULT_SHARE_LINK_EXPIRY_DAYS }),
        );
    });

    it('explains an unenrolled machine rather than crashing', async () => {
        const out = await mintWorkstationShareLink(
            { allWorkspaces: true, capability: 'control' },
            deps({ identity: () => null }),
        );

        expect(out.ok).toBe(false);
        expect(out.ok === false && out.error).toMatch(/sign in|Tynn/i);
    });
});

describe('listWorkspaceShareLinks', () => {
    it('lists this workspace’s links under this machine', async () => {
        const d = deps();
        await listWorkspaceShareLinks('ws-design', d);

        expect(d.backend.listWorkspaceShareLinks).toHaveBeenCalledWith('wst-1', 'ws-design');
    });

    it('returns an empty list for an unenrolled machine without calling Tynn', async () => {
        const d = deps({ identity: () => null });
        const out = await listWorkspaceShareLinks('ws-design', d);

        expect(out).toEqual([]);
        expect(d.backend.listWorkspaceShareLinks).not.toHaveBeenCalled();
    });
});

describe('revokeWorkspaceShareLink', () => {
    it('revokes under this machine and reports success', async () => {
        const d = deps();
        const out = await revokeWorkspaceShareLink('inv1', d);

        expect(out).toEqual({ ok: true });
        expect(d.backend.revokeWorkspaceShareLink).toHaveBeenCalledWith('wst-1', 'inv1');
    });

    it('reports a FAILED revoke as failed', async () => {
        // The one thing this surface must never do is claim a link is dead when it
        // is still live. Swallowing the error would do exactly that.
        const d = deps({
            backend: {
                ...deps().backend,
                revokeWorkspaceShareLink: vi.fn(async () => {
                    throw new Error('Tynn DELETE → 500');
                }),
            },
        });

        const out = await revokeWorkspaceShareLink('inv1', d);

        expect(out.ok).toBe(false);
    });
});
